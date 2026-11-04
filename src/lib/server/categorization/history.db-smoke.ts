import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { categorySetBy, type CategorySetBy } from '$lib/domain/categorySetBy';
import { suggestFromHistory } from '$lib/domain/historySuggestion';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { loadMemberHistory } from './history';
import { actions, load } from '../../../routes/transactions/+page.server';

/**
 * #1014: the history suggester learns only from what THIS member chose, read through
 * `categorySetBy`, and the accept refuses a row whose category changed since it was proposed.
 * Driven against a real engine because the claim is about a where clause: a unit fake decides
 * what `findMany` returns, so removing `userId` from it would leave a unit spec green.
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
	categories: Array<{ id: string; name: string }>;
	locals: { user: { id: string; email: string; role: string } };
};

async function seed(): Promise<Seed> {
	const email = `history-smoke-${crypto.randomUUID()}@budgetpilot.invalid`;
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
		[UNCLASSIFIED_CATEGORY, 'Courses', 'Loisirs', 'Ancienne'].map((name) =>
			prisma.category.create({
				data: { userId, name, nameKey: computeNameKey(name) },
				select: { id: true, name: true }
			})
		)
	);
	return {
		userId,
		accountId: account.id,
		uncategorizedId: categories[0].id,
		categories,
		locals: { user: { id: userId, email, role: 'user' } }
	};
}

async function row(
	s: Seed,
	label: string,
	pin: string | null = null,
	source: CategorySetBy | null = null,
	day = 10
): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: s.userId,
			accountId: s.accountId,
			categoryId: s.uncategorizedId,
			date: new Date(Date.UTC(2026, 2, day)),
			label,
			amountCents: BigInt(-4200),
			type: 'expense',
			source: 'csv',
			...(pin === null ? {} : manualCategoryUpdate(pin, source))
		},
		select: { id: true }
	});
	return created.id;
}

const history = (s: Seed) => loadMemberHistory(s.userId, s.categories, s.uncategorizedId);

describe('what the history suggester may learn from (#1014)', () => {
	it('learns a category the member set', async () => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member');
		expect(suggestFromHistory(await history(s), 'CB PRIMEUR LOMI 09/03')).toBe('Courses');
	});

	// One test per excluded author, so each exclusion is broken and seen red on its own.
	it.each<[string, CategorySetBy]>([
		['a rule', 'rule'],
		['an accepted suggestion', 'acceptedSuggestion']
	])('does not learn a category set by %s', async (_name, source) => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', source);
		expect(suggestFromHistory(await history(s), 'CB PRIMEUR LOMI 09/03')).toBeNull();
	});

	it('does not learn a pin whose author was written for another pin (unknown)', async () => {
		const s = await seed();
		const id = await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member');
		await prisma.transaction.update({
			where: { id },
			data: { manualCategory: 'Loisirs', manualCategoryKey: computeNameKey('Loisirs') }
		});
		const stored = await prisma.transaction.findUniqueOrThrow({ where: { id } });
		expect(categorySetBy(stored)).toBe('unknown');
		expect(suggestFromHistory(await history(s), 'CB PRIMEUR LOMI 09/03')).toBeNull();
	});

	it('does not learn the uncategorized sentinel the member pinned', async () => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', UNCLASSIFIED_CATEGORY, 'member');
		expect(suggestFromHistory(await history(s), 'CB PRIMEUR LOMI 09/03')).toBeNull();
	});

	it('does not propose a category the member has deleted since', async () => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', 'Ancienne', 'member');
		const live = s.categories.filter((c) => c.name !== 'Ancienne');
		const index = await loadMemberHistory(s.userId, live, s.uncategorizedId);
		expect(suggestFromHistory(index, 'CB PRIMEUR LOMI 09/03')).toBeNull();
	});

	// Code pass 1 (A N17a, B node 5): the source clause sits BEFORE the row cap, so the cap counts
	// member rows only. With a cap of one, a newer rule row must not crowd out the older member
	// row. Separates a where clause that filters before `take` from a filter applied after it.
	it('counts only member rows against the cap, so newer rule rows cannot crowd them out', async () => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member', 2);
		await row(s, 'CB CINEMA ZUPEL 05/03', 'Loisirs', 'rule', 5);
		const index = await loadMemberHistory(s.userId, s.categories, s.uncategorizedId, 1);
		expect(suggestFromHistory(index, 'CB PRIMEUR LOMI 09/03')).toBe('Courses');
	});

	// ASVS v5.0.0-8.2.2: another member's choices never reach this member's suggestions.
	it('never learns from another member', async () => {
		const s = await seed();
		const other = await seed();
		await row(other, 'CB CINEMA ZUPEL 02/03', 'Loisirs', 'member');
		expect(suggestFromHistory(await history(s), 'CB CINEMA ZUPEL 09/03')).toBeNull();
	});
});

function post(action: (event: never) => unknown, fields: [string, string][]) {
	const formData = new FormData();
	for (const [name, value] of fields) formData.append(name, value);
	return (s: Seed) =>
		action({
			locals: s.locals,
			request: new Request('http://localhost/transactions?/acceptSuggestion', {
				method: 'POST',
				body: formData
			})
		} as never);
}

type Listed = { id: string; suggestion: unknown };

async function listed(s: Seed, id: string): Promise<Listed | undefined> {
	const data = (await load({
		locals: s.locals,
		url: new URL('http://localhost/transactions?type=classify')
	} as never)) as { transactions: Listed[] };
	return data.transactions.find((t) => t.id === id);
}

const accept = (s: Seed, fields: [string, string][]) => post(actions.acceptSuggestion, fields)(s);

async function stored(id: string) {
	const found = await prisma.transaction.findUniqueOrThrow({ where: { id } });
	return { pin: found.manualCategory, by: categorySetBy(found) };
}

describe('the proposal on the transactions page (#1014)', () => {
	// The route that produces the state: the list's load, on the classify tab, on an account with
	// no nature mapping for the sentinel, which is every fresh install (no seed writes one). Before
	// #1014 the proposal was gated on nature alone, and such a row's nature falls back to
	// « spending » by kind, so the list never showed one. Separates a gate on the pile from one on
	// nature.
	it('proposes a rule’s category on a pile row of a fresh install', async () => {
		const s = await seed();
		await prisma.categoryRule.create({
			data: { userId: s.userId, name: 'Primeur', matchText: 'PRIMEUR', targetCategory: 'Courses' }
		});
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03');
		expect((await listed(s, pending))?.suggestion).toEqual({
			category: 'Courses',
			nature: null,
			source: 'rule'
		});
	});

	it('proposes the member’s category, labelled as coming from their history', async () => {
		const s = await seed();
		await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member', 2);
		const pending = await row(s, 'CB PRIMEUR LOMI 09/03', null, null, 9);
		expect((await listed(s, pending))?.suggestion).toEqual({
			category: 'Courses',
			nature: null,
			source: 'history'
		});
	});

	// Pass 1, N12: a row the member pinned is never proposed anything, as for rules
	// (`findMatchingCategoryRule` returns null on a pin), even when its nature reads uncategorized.
	// Nine earlier rows, so the history still clears the floor with the pinned row counted in it
	// (9 of 10): with one, the pinned row itself split the vote and the gate went unobserved.
	it('proposes nothing on a row the member pinned, whatever its nature', async () => {
		const s = await seed();
		for (let day = 1; day <= 9; day++)
			await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member', day);
		const pinned = await row(s, 'CB PRIMEUR LOMI 09/03', 'Loisirs', 'member', 20);
		await prisma.transaction.update({
			where: { id: pinned },
			data: { natureManual: 'uncategorized' }
		});
		const data = (await load({
			locals: s.locals,
			url: new URL('http://localhost/transactions')
		} as never)) as { transactions: Listed[] };
		expect(data.transactions.find((t) => t.id === pinned)?.suggestion).toBeNull();
	});
});

// Code pass 1: three row states the widened gate must still leave alone, each one the accept
// could not apply cleanly. Every fixture carries a history that clears the floor, so a missing
// clause shows as a proposal.
describe('rows the gate leaves without a proposal (#1014)', () => {
	async function withHistory(s: Seed) {
		for (let day = 1; day <= 5; day++)
			await row(s, 'CB PRIMEUR LOMI 02/03', 'Courses', 'member', day);
	}
	async function listedAnyTab(s: Seed, id: string) {
		const data = (await load({
			locals: s.locals,
			url: new URL('http://localhost/transactions')
		} as never)) as { transactions: Listed[] };
		return data.transactions.find((t) => t.id === id);
	}

	// B 7a, at the bar: accepting would write the proposal's empty nature over the member's own.
	it('a pile row whose nature the member set by hand', async () => {
		const s = await seed();
		await withHistory(s);
		const id = await row(s, 'CB PRIMEUR LOMI 09/03', null, null, 20);
		await prisma.transaction.update({ where: { id }, data: { natureManual: 'transfer' } });
		expect((await listed(s, id))?.suggestion).toBeNull();
	});

	// B 7b, A: the parts carry the categories; the accept would answer « locked by split ».
	it('a split row whose parent still carries the sentinel', async () => {
		const s = await seed();
		await withHistory(s);
		const id = await row(s, 'CB PRIMEUR LOMI 09/03', null, null, 20);
		const courses = s.categories.find((c) => c.name === 'Courses')!;
		const loisirs = s.categories.find((c) => c.name === 'Loisirs')!;
		await prisma.transactionSplit.createMany({
			data: [
				{ transactionId: id, categoryId: courses.id, amountCents: BigInt(-2100), position: 0 },
				{ transactionId: id, categoryId: loisirs.id, amountCents: BigInt(-2100), position: 1 }
			]
		});
		expect((await listedAnyTab(s, id))?.suggestion).toBeNull();
	});

	// A F2: the gate and the accept read « no pin » as the same predicate, so an empty pin a
	// restore can write is a pin for both, never a proposal the accept then refuses.
	it('a row carrying an empty pin', async () => {
		const s = await seed();
		await withHistory(s);
		const id = await row(s, 'CB PRIMEUR LOMI 09/03', null, null, 20);
		await prisma.transaction.update({
			where: { id },
			data: { manualCategory: '', natureManual: 'uncategorized' }
		});
		expect((await listedAnyTab(s, id))?.suggestion).toBeNull();
	});
});

describe('accepting a proposal (#1014)', () => {
	it('records an accepted suggestion when the posted category is the one proposed', async () => {
		const s = await seed();
		const id = await row(s, 'CB PRIMEUR LOMI 09/03');
		const result = await accept(s, [
			['transactionId', id],
			['proposed', 'Courses'],
			['category', 'Courses'],
			['nature', ''],
			['seen', '{"category":null,"nature":null}']
		]);
		expect(result).toMatchObject({ acceptSuccess: true });
		expect(await stored(id)).toEqual({ pin: 'Courses', by: 'acceptedSuggestion' });
	});

	// Pass 1, N3: the card's category is editable, so a different category is the member's own
	// pick and must reach their history. Separates a source decided by the post from one stamped
	// by the action whatever was posted.
	it('records the member when they changed the proposed category before accepting', async () => {
		const s = await seed();
		const id = await row(s, 'CB PRIMEUR LOMI 09/03');
		await accept(s, [
			['transactionId', id],
			['proposed', 'Courses'],
			['category', 'Loisirs'],
			['nature', ''],
			['seen', '{"category":null,"nature":null}']
		]);
		expect(await stored(id)).toEqual({ pin: 'Loisirs', by: 'member' });
	});

	// Review focus 2 of the 1.4 plan: a proposal computed before the member filed the row by hand
	// must not overwrite that choice. Separates an accept guarded on « no pin » from one guarded
	// on ownership alone.
	it('refuses a proposal on a row the member categorized since, and keeps their choice', async () => {
		const s = await seed();
		const id = await row(s, 'CB PRIMEUR LOMI 09/03');
		await prisma.transaction.update({
			where: { id },
			data: manualCategoryUpdate('Loisirs', 'member')
		});
		const refused = await accept(s, [
			['transactionId', id],
			['proposed', 'Courses'],
			['category', 'Courses'],
			['nature', ''],
			['seen', '{"category":null,"nature":null}']
		]);
		expect(refused).toMatchObject({ status: 409 });
		expect(await stored(id)).toEqual({ pin: 'Loisirs', by: 'member' });
	});

	// Pass 1, N3b: with no proposal posted the card is a category editor, as it is today, so a
	// correction right after an accept still applies.
	it('lets the card correct a category with no proposal posted', async () => {
		const s = await seed();
		const id = await row(s, 'CB PRIMEUR LOMI 09/03', 'Courses', 'acceptedSuggestion');
		const result = await accept(s, [
			['transactionId', id],
			['proposed', ''],
			['category', 'Loisirs'],
			['nature', ''],
			['seen', '{"category":"Courses","nature":null}']
		]);
		expect(result).toEqual({ acceptSuccess: true });
		expect(await stored(id)).toEqual({ pin: 'Loisirs', by: 'member' });
	});

	// ASVS v5.0.0-8.2.2, and pass 1 N7: another member's row is not-found, never « categorized
	// since », so the 409 says nothing about an id this member does not own.
	it('answers 404, not 409, for another member’s pinned row, and leaves it untouched', async () => {
		const s = await seed();
		const other = await seed();
		const theirs = await row(other, 'CB PRIMEUR LOMI 09/03', 'Loisirs', 'member');
		const refused = await accept(s, [
			['transactionId', theirs],
			['proposed', 'Courses'],
			['category', 'Courses'],
			['nature', ''],
			['seen', '{"category":null,"nature":null}']
		]);
		expect(refused).toMatchObject({ status: 404 });
		expect(await stored(theirs)).toEqual({ pin: 'Loisirs', by: 'member' });
	});
});
