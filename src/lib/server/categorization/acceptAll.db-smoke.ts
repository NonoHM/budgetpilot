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
			['proposed', 'Courses']
		]);
		const record = (outcome.proposalsAccepted as Accepted | undefined)?.undo;
		expect(record).toBeTypeOf('string');
		const undone = await undo(s, record!);
		expect(undone.proposalsUndone).toEqual({ undone: 1, changedSince: 0 });
		expect(await stored(pending)).toEqual(before);
	});
});
