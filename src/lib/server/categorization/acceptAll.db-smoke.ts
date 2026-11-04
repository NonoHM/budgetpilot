import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { categorySetBy, type CategorySetBy } from '$lib/domain/categorySetBy';
import type { TransactionNature } from '$lib/domain/transaction';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { actions } from '../../../routes/transactions/+page.server';

/**
 * #1230: « Accept all » over the proposals the page shows, and an exact undo for it and for the
 * single accept. Driven through the route's own actions against a real engine, because every
 * claim here is a where clause (ownership, « still as proposed », « still as written »), and a
 * unit fake decides what the engine returns.
 */

env.RATE_LIMIT_HASH_SECRET ??= 'c3'.repeat(32);

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error('DATABASE_URL points at dev.db. Point it at a throwaway database instead.');
}

const createdUserIds: string[] = [];

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

type Seed = {
	userId: string;
	accountId: string;
	uncategorizedId: string;
	locals: { user: { id: string; email: string; role: string } };
};

async function seed(): Promise<Seed> {
	const email = `accept-all-smoke-${crypto.randomUUID()}@budgetpilot.invalid`;
	const { id: userId } = await prisma.user.create({
		data: { email, passwordHash: 'db-smoke-not-a-real-hash' },
		select: { id: true }
	});
	createdUserIds.push(userId);
	const account = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name: 'Compte courant',
			nameKey: computeNameKey('Compte courant'),
			source: 'csv'
		},
		select: { id: true }
	});
	const categories = await Promise.all(
		[UNCLASSIFIED_CATEGORY, 'Courses', 'Loisirs'].map((name) =>
			prisma.category.create({
				data: { userId, name, nameKey: computeNameKey(name) },
				select: { id: true }
			})
		)
	);
	await prisma.categoryRule.create({
		data: { userId, name: 'Cinema', matchText: 'CINEMA', targetCategory: 'Loisirs' }
	});
	return {
		userId,
		accountId: account.id,
		uncategorizedId: categories[0].id,
		locals: { user: { id: userId, email, role: 'user' } }
	};
}

async function row(
	s: Seed,
	label: string,
	options: { pin?: string; by?: CategorySetBy; day?: number; nature?: TransactionNature } = {}
): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: s.userId,
			accountId: s.accountId,
			categoryId: s.uncategorizedId,
			date: new Date(Date.UTC(2026, 2, options.day ?? 20)),
			label,
			amountCents: BigInt(-4200),
			type: 'expense',
			source: 'csv',
			natureManual: options.nature ?? null,
			...(options.pin === undefined ? {} : manualCategoryUpdate(options.pin, options.by ?? null))
		},
		select: { id: true }
	});
	return created.id;
}

/** A merchant the member filed under Courses five times: its next row is proposed Courses. */
async function primeurHistory(s: Seed) {
	for (let day = 1; day <= 5; day++)
		await row(s, 'CB PRIMEUR LOMI 02/03', { pin: 'Courses', by: 'member', day });
}

type Outcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

async function post(
	s: Seed,
	action: 'acceptAllProposals' | 'undoAcceptedProposals' | 'acceptSuggestion',
	fields: [string, string][]
): Promise<Outcome> {
	const formData = new FormData();
	for (const [name, value] of fields) formData.append(name, value);
	return (await (actions[action] as (event: never) => unknown)({
		locals: s.locals,
		request: new Request(`http://localhost/transactions?/${action}`, {
			method: 'POST',
			body: formData
		})
	} as never)) as Outcome;
}

type Shown = { id: string; category: string; nature?: TransactionNature | null };

/** What the page posts: each row's id with the category and nature it showed. */
const acceptAll = (s: Seed, shown: Shown[]) =>
	post(s, 'acceptAllProposals', [
		['proposals', JSON.stringify(shown.map((row) => ({ nature: null, ...row })))]
	]);

type Accepted = { accepted: number; changedSince: number; undo: string };

function accepted(outcome: Outcome): Accepted {
	const result = outcome.proposalsAccepted as Accepted | undefined;
	if (!result) throw new Error(`no proposalsAccepted in ${JSON.stringify(outcome)}`);
	return result;
}

const undo = (s: Seed, record: string) => post(s, 'undoAcceptedProposals', [['undo', record]]);

async function stored(id: string) {
	const found = await prisma.transaction.findUniqueOrThrow({ where: { id } });
	return {
		pin: found.manualCategory,
		key: found.manualCategoryKey,
		source: found.manualCategorySource,
		sourceKey: found.manualCategorySourceKey,
		by: categorySetBy(found),
		nature: found.natureManual
	};
}

describe('« Accept all » over the proposals the page shows (#1230)', () => {
	it('accepts a rule proposal and a history proposal, each as an accepted suggestion', async () => {
		const s = await seed();
		await primeurHistory(s);
		const fromHistory = await row(s, 'CB PRIMEUR LOMI 09/03');
		const fromRule = await row(s, 'CB CINEMA ODEON');
		const result = accepted(
			await acceptAll(s, [
				{ id: fromHistory, category: 'Courses' },
				{ id: fromRule, category: 'Loisirs' }
			])
		);
		expect(result.accepted).toBe(2);
		expect(result.changedSince).toBe(0);
		expect(await stored(fromHistory)).toMatchObject({ pin: 'Courses', by: 'acceptedSuggestion' });
		expect(await stored(fromRule)).toMatchObject({ pin: 'Loisirs', by: 'acceptedSuggestion' });
	});

	// Separates « the server writes its own proposal » from « the server writes what was posted »:
	// the posted category is one the member owns and the server would never propose for this row.
	it('writes nothing where the posted category is not the server’s proposal', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Loisirs' }]));
		expect(result).toMatchObject({ accepted: 0, changedSince: 1 });
		expect(await stored(pending)).toMatchObject({ pin: null, by: null });
	});

	// Note pass 1, F2: the list shows the proposal's nature, so a nature the member never saw is
	// not written either. Separates a match on category alone from a match on category and nature.
	it('writes nothing where the proposal’s nature changed since the page showed it', async () => {
		const s = await seed();
		const pending = await row(s, 'CB CINEMA ODEON');
		await prisma.categoryRule.updateMany({
			where: { userId: s.userId },
			data: { targetNature: 'spending' }
		});
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Loisirs' }]));
		expect(result).toMatchObject({ accepted: 0, changedSince: 1 });
		expect(await stored(pending)).toMatchObject({ pin: null, nature: null });
	});

	it('leaves a row the member filed since the page showed it, and counts it', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		await prisma.transaction.update({
			where: { id: pending },
			data: manualCategoryUpdate('Loisirs', 'member')
		});
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Courses' }]));
		expect(result).toMatchObject({ accepted: 0, changedSince: 1 });
		expect(await stored(pending)).toMatchObject({ pin: 'Loisirs', by: 'member' });
	});

	// All or none on ownership: the member's own row named beside a foreign one is not written.
	it('refuses the whole list as not found when one id is another member’s', async () => {
		const s = await seed();
		const other = await seed();
		await primeurHistory(s);
		await primeurHistory(other);
		const mine = await row(s, 'CB PRIMEUR LOMI 09/03');
		const theirs = await row(other, 'CB PRIMEUR LOMI 09/03');
		const outcome = await acceptAll(s, [
			{ id: mine, category: 'Courses' },
			{ id: theirs, category: 'Courses' }
		]);
		expect(outcome.status).toBe(404);
		expect(await stored(mine)).toMatchObject({ pin: null });
		expect(await stored(theirs)).toMatchObject({ pin: null });
	});

	// Code pass 1A F1 / 1B R1: a category may be named up to 80 characters, and the posted name is
	// only compared by key. A 60 cap refused the whole page for one such row, and a reload could
	// not help. Separates a bound at the stored name from one at the hand-typed pin.
	it('accepts and undoes a proposal whose category name is longer than 60 characters', async () => {
		const s = await seed();
		const long = 'Abonnements et services numeriques partages avec la famille proche';
		expect(long.length).toBeGreaterThan(60);
		await prisma.category.create({
			data: { userId: s.userId, name: long, nameKey: computeNameKey(long) }
		});
		await prisma.categoryRule.create({
			data: { userId: s.userId, name: 'Stream', matchText: 'STREAMFLIX', targetCategory: long }
		});
		const pending = await row(s, 'PRLV STREAMFLIX');
		const result = accepted(await acceptAll(s, [{ id: pending, category: long }]));
		expect(result).toMatchObject({ accepted: 1, changedSince: 0 });
		const undone = await undo(s, result.undo);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 0 });
	});

	it('refuses a list longer than one page', async () => {
		const s = await seed();
		// Well-formed ids that resolve to nothing: without the cap this answers 404, not 400.
		const shown = Array.from({ length: 26 }, (_, i) => ({
			id: `missing-row-${i}`,
			category: 'Courses'
		}));
		const outcome = await acceptAll(s, shown);
		expect(outcome.status).toBe(400);
	});

	it('refuses an id named twice', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		const outcome = await acceptAll(s, [
			{ id: pending, category: 'Courses' },
			{ id: pending, category: 'Courses' }
		]);
		expect(outcome.status).toBe(400);
		expect(await stored(pending)).toMatchObject({ pin: null });
	});
});

describe('the undo after an accept (#1230)', () => {
	// The previous nature is the one stored before the click: a row whose nature the member set to
	// uncategorized by hand is proposed (its effective nature reads uncategorized), and the rule's
	// accept writes the proposal's own nature over it.
	it('restores the pin, its author and the nature the click replaced', async () => {
		const s = await seed();
		await prisma.categoryRule.updateMany({
			where: { userId: s.userId },
			data: { targetNature: 'spending' }
		});
		const pending = await row(s, 'CB CINEMA ODEON', { nature: 'uncategorized' });
		const before = await stored(pending);
		const result = accepted(
			await acceptAll(s, [{ id: pending, category: 'Loisirs', nature: 'spending' }])
		);
		expect(await stored(pending)).toMatchObject({ pin: 'Loisirs', nature: 'spending' });
		const undone = await undo(s, result.undo);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 0 });
		expect(await stored(pending)).toEqual(before);
	});

	it('leaves alone a row the member changed after the click, and counts it', async () => {
		const s = await seed();
		await primeurHistory(s);
		const kept = await row(s, 'CB PRIMEUR LOMI 09/03');
		const changed = await row(s, 'CB PRIMEUR LOMI 10/03');
		const result = accepted(
			await acceptAll(s, [
				{ id: kept, category: 'Courses' },
				{ id: changed, category: 'Courses' }
			])
		);
		// The same category, now the member's own choice: only the author moved.
		await prisma.transaction.update({
			where: { id: changed },
			data: manualCategoryUpdate('Courses', 'member')
		});
		const undone = await undo(s, result.undo);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 1 });
		expect(await stored(kept)).toMatchObject({ pin: null, by: null });
		expect(await stored(changed)).toMatchObject({ pin: 'Courses', by: 'member' });
	});

	// The nature is the member's to change too: a nature set after the click keeps the row as is.
	it('leaves a row whose nature the member set after the click, and counts it', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Courses' }]));
		await prisma.transaction.update({ where: { id: pending }, data: { natureManual: 'income' } });
		const undone = await undo(s, result.undo);
		expect(undone.proposalsUndone).toEqual({ undone: 0, changedSince: 1 });
		expect(await stored(pending)).toMatchObject({ pin: 'Courses', nature: 'income' });
	});

	// Note pass 1, F1: a row split after the click keeps its parent's category, which the member's
	// own editor refuses to change while the row has parts.
	it('leaves a row split after the click, and counts it', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Courses' }]));
		const [courses, loisirs] = await Promise.all(
			['Courses', 'Loisirs'].map((name) =>
				prisma.category.findFirstOrThrow({ where: { userId: s.userId, name } })
			)
		);
		await prisma.transactionSplit.createMany({
			data: [
				{ transactionId: pending, categoryId: courses.id, amountCents: BigInt(-2100), position: 0 },
				{ transactionId: pending, categoryId: loisirs.id, amountCents: BigInt(-2100), position: 1 }
			]
		});
		const undone = await undo(s, result.undo);
		expect(undone.proposalsUndone).toEqual({ undone: 0, changedSince: 1 });
		expect(await stored(pending)).toMatchObject({ pin: 'Courses', by: 'acceptedSuggestion' });
	});

	it('is idempotent: a second undo restores nothing', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		const result = accepted(await acceptAll(s, [{ id: pending, category: 'Courses' }]));
		await undo(s, result.undo);
		const again = await undo(s, result.undo);
		expect(again.proposalsUndone).toEqual({ undone: 0, changedSince: 1 });
	});

	it('refuses as not found a record naming another member’s row, and restores nothing', async () => {
		const s = await seed();
		const other = await seed();
		await primeurHistory(s);
		await primeurHistory(other);
		const mine = await row(s, 'CB PRIMEUR LOMI 09/03');
		const theirs = await row(other, 'CB PRIMEUR LOMI 09/03');
		const myRecord = JSON.parse(
			accepted(await acceptAll(s, [{ id: mine, category: 'Courses' }])).undo
		) as unknown[];
		const theirRecord = JSON.parse(
			accepted(await acceptAll(other, [{ id: theirs, category: 'Courses' }])).undo
		) as unknown[];
		const outcome = await undo(s, JSON.stringify([...myRecord, ...theirRecord]));
		expect(outcome.status).toBe(404);
		expect(await stored(mine)).toMatchObject({ pin: 'Courses', by: 'acceptedSuggestion' });
		expect(await stored(theirs)).toMatchObject({ pin: 'Courses', by: 'acceptedSuggestion' });
	});

	it('refuses a record that is not a list of accepted rows', async () => {
		const s = await seed();
		for (const record of ['', 'not json', '{}', JSON.stringify([{ id: 'x' }])]) {
			const outcome = await undo(s, record);
			expect(outcome.status, record).toBe(400);
		}
	});

	// A nature set by hand to uncategorized, so the record must carry it for the undo to be exact.
	it('undoes a single accepted proposal with the same record', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03', { nature: 'uncategorized' });
		const before = await stored(pending);
		const outcome = await post(s, 'acceptSuggestion', [
			['transactionId', pending],
			['category', 'Courses'],
			['nature', ''],
			['proposed', 'Courses'],
			['seen', '{"category":null,"nature":"uncategorized"}']
		]);
		const record = (outcome.proposalsAccepted as Accepted | undefined)?.undo;
		expect(record).toBeTypeOf('string');
		const undone = await undo(s, record!);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 0 });
		expect(await stored(pending)).toEqual(before);
	});
});

/**
 * #1231 and #1233: the single accept compares the row with what the page showed it as, its pin and
 * its manual nature, posted as `seen`, in the same where as the write. Each test below separates a
 * guard that compares against the PAGE from one that compares against the row as read at click
 * time, which is what the accept did before: the click-time read sees the other tab's change and
 * repeats it, so the write goes through.
 */
describe('a single accept from a page older than the row (#1231, #1233)', () => {
	const seen = (category: string | null, nature: TransactionNature | null) =>
		JSON.stringify({ category, nature });
	const acceptOne = (s: Seed, id: string, fields: [string, string][]) =>
		post(s, 'acceptSuggestion', [['transactionId', id], ...fields]);

	// #1231: a nature the member set in another tab after the page showed the proposal.
	it('refuses a proposal on a row whose nature the member set since, and keeps that nature', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		await prisma.transaction.update({ where: { id: pending }, data: { natureManual: 'spending' } });
		const outcome = await acceptOne(s, pending, [
			['category', 'Courses'],
			['nature', ''],
			['proposed', 'Courses'],
			['seen', seen(null, null)]
		]);
		expect(outcome.status).toBe(409);
		expect(await stored(pending)).toMatchObject({ pin: null, nature: 'spending' });
	});

	// #1231, the case the proposal gate still shows a proposal for: set by hand to uncategorized.
	it('refuses a proposal on a row whose nature moved to uncategorized since', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		await prisma.transaction.update({
			where: { id: pending },
			data: { natureManual: 'uncategorized' }
		});
		const outcome = await acceptOne(s, pending, [
			['category', 'Courses'],
			['nature', ''],
			['proposed', 'Courses'],
			['seen', seen(null, null)]
		]);
		expect(outcome.status).toBe(409);
		expect(await stored(pending)).toMatchObject({ pin: null, nature: 'uncategorized' });
	});

	// #1233, point 2: no proposal shown, the row filed in another tab since focus opened.
	it('refuses a category picked with no proposal on a row filed since, and keeps the pin', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU');
		await prisma.transaction.update({
			where: { id: pending },
			data: manualCategoryUpdate('Courses', 'member')
		});
		const outcome = await acceptOne(s, pending, [
			['category', 'Loisirs'],
			['nature', ''],
			['proposed', ''],
			['seen', seen(null, null)]
		]);
		expect(outcome.status).toBe(409);
		expect(await stored(pending)).toMatchObject({ pin: 'Courses', by: 'member', nature: null });
	});

	// #1233, point 1, the server half: the card now posts the nature it started on, the row's own.
	it('accepts a category picked with no proposal on an unchanged row, keeping its manual nature', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU', { nature: 'spending' });
		const outcome = await acceptOne(s, pending, [
			['category', 'Loisirs'],
			['nature', 'spending'],
			['proposed', ''],
			['seen', seen(null, 'spending')]
		]);
		expect(outcome.status).toBeUndefined();
		expect(await stored(pending)).toMatchObject({
			pin: 'Loisirs',
			by: 'member',
			nature: 'spending'
		});
	});

	// Note pass 1, #9a: only the nature changed, and no proposal. Separates a where that compares the
	// nature on both paths from one that compares it only when a proposal is posted.
	it('refuses a category picked with no proposal on a row whose nature the member set since', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU');
		await prisma.transaction.update({ where: { id: pending }, data: { natureManual: 'spending' } });
		const outcome = await acceptOne(s, pending, [
			['category', 'Loisirs'],
			['nature', ''],
			['proposed', ''],
			['seen', seen(null, null)]
		]);
		expect(outcome.status).toBe(409);
		expect(await stored(pending)).toMatchObject({ pin: null, nature: 'spending' });
	});

	// Note point 3: a proposal is only shown on an unpinned row, so a pinned `seen` beside one is no
	// page state. Separates refusing the pair from writing a proposal's author over a pin.
	it('refuses a proposal posted beside a pinned row as no page state', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU', { pin: 'Courses', by: 'member' });
		const outcome = await acceptOne(s, pending, [
			['category', 'Courses'],
			['nature', ''],
			['proposed', 'Courses'],
			['seen', seen('Courses', null)]
		]);
		expect(outcome.status).toBe(400);
		expect((outcome.data as { acceptError?: string }).acceptError).toBe('Invalid transaction.');
		expect(await stored(pending)).toMatchObject({ pin: 'Courses', by: 'member' });
	});

	// A pin the page saw is compared too: a pile row pinned to the sentinel, re-pinned since.
	it('refuses a row whose pin changed since, whatever pin the page saw', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU', { pin: UNCLASSIFIED_CATEGORY, by: 'member' });
		await prisma.transaction.update({
			where: { id: pending },
			data: manualCategoryUpdate('Courses', 'member')
		});
		const outcome = await acceptOne(s, pending, [
			['category', 'Loisirs'],
			['nature', ''],
			['proposed', ''],
			['seen', seen(UNCLASSIFIED_CATEGORY, null)]
		]);
		expect(outcome.status).toBe(409);
		expect(await stored(pending)).toMatchObject({ pin: 'Courses' });
	});

	// The pin is compared by its key: a case-only respelling since files the row under the same
	// category, so it is no change, on every engine. Separates the key from the raw name, which
	// sqlite and PostgreSQL compare case-sensitively and MariaDB's collation does not.
	it('accepts on a row whose pin was only respelled in another case since', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU', { pin: 'Courses', by: 'member' });
		await prisma.transaction.update({
			where: { id: pending },
			data: manualCategoryUpdate('COURSES', 'member')
		});
		const outcome = await acceptOne(s, pending, [
			['category', 'Loisirs'],
			['nature', ''],
			['proposed', ''],
			['seen', seen('Courses', null)]
		]);
		expect(outcome.status).toBeUndefined();
		expect(await stored(pending)).toMatchObject({ pin: 'Loisirs', by: 'member' });
	});

	it('accepts an unchanged proposal row, and its undo restores what the page saw', async () => {
		const s = await seed();
		await primeurHistory(s);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03', { nature: 'uncategorized' });
		const before = await stored(pending);
		const outcome = await acceptOne(s, pending, [
			['category', 'Courses'],
			['nature', ''],
			['proposed', 'Courses'],
			['seen', seen(null, 'uncategorized')]
		]);
		expect(await stored(pending)).toMatchObject({ pin: 'Courses', by: 'acceptedSuggestion' });
		const undone = await undo(s, accepted(outcome).undo);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 0 });
		expect(await stored(pending)).toEqual(before);
	});

	// The reason, not only the refusal: a missing or malformed `seen` is the page's fault, a 400
	// with the invalid-transaction sentence, and nothing is written.
	it('refuses an accept that does not say what the page saw', async () => {
		const s = await seed();
		const pending = await row(s, 'VIR SEPA INCONNU');
		for (const value of [null, '', 'null', '{}', seen(null, null).replace('null}', '"bogus"}')]) {
			const fields: [string, string][] = [
				['category', 'Loisirs'],
				['nature', ''],
				['proposed', '']
			];
			if (value !== null) fields.push(['seen', value]);
			const outcome = await acceptOne(s, pending, fields);
			expect(outcome.status, String(value)).toBe(400);
			expect((outcome.data as { acceptError?: string }).acceptError, String(value)).toBe(
				'Invalid transaction.'
			);
		}
		expect(await stored(pending)).toMatchObject({ pin: null, by: null });
	});

	// Ownership stays the not-found answer, `seen` matching the foreign row exactly.
	it('refuses another member’s row as not found, whatever the page says it saw', async () => {
		const mine = await seed();
		const theirs = await seed();
		const foreign = await row(theirs, 'VIR SEPA INCONNU');
		const outcome = await acceptOne(mine, foreign, [
			['category', 'Loisirs'],
			['nature', ''],
			['proposed', ''],
			['seen', seen(null, null)]
		]);
		expect(outcome.status).toBe(404);
		expect(await stored(foreign)).toMatchObject({ pin: null, by: null });
	});
});
