import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { buildBackupExport } from '$lib/server/backup/export';
import { BackupImportError, restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import { runNameKeyBackfill } from '$lib/server/naming/backfill';
import { replaceSplits } from './splits';
import {
	clearReadPair,
	confirmTransferPair,
	listTransferProposals,
	pairAllProposed,
	undoTransferPairs
} from './transferPairs';

// #1189. Rows are seeded in the shape `server/import/persist.ts` writes them: a magnitude in
// `amountCents` and the direction in `type`, so an imported expense is stored POSITIVE.

env.RATE_LIMIT_HASH_SECRET = 'a9'.repeat(32);

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const WINDOW_DAYS = 5;
const createdUserIds: string[] = [];

afterAll(async () => {
	if (createdUserIds.length > 0) {
		// Transactions first, as the app's two user-deletion paths do: a split part's category
		// has no cascade, so PostgreSQL refuses the user delete otherwise (splits.db-smoke.ts).
		await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

interface Seed {
	userId: string;
	checking: string;
	savings: string;
	categoryId: string;
}

async function seed(): Promise<Seed> {
	const { id: userId } = await prisma.user.create({
		data: {
			email: `pairs-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(userId);
	const [checking, savings] = await Promise.all(
		['Compte courant', 'Livret A'].map((name) =>
			prisma.account.create({
				// Keyed eagerly: an unkeyed account is pending for `runNameKeyBackfill`, which reads the
				// whole database (crossProvider.db-smoke.ts, « boot backfills »).
				data: {
					...DEFAULT_DENOMINATION,
					userId,
					name,
					nameKey: computeNameKey(name),
					source: 'csv'
				},
				select: { id: true }
			})
		)
	);
	const category = await prisma.category.create({
		data: { userId, name: 'Divers', nameKey: computeNameKey('Divers') },
		select: { id: true }
	});
	return { userId, checking: checking.id, savings: savings.id, categoryId: category.id };
}

async function row(
	s: Seed,
	accountId: string,
	type: 'income' | 'expense',
	over: { date?: string; amountCents?: number } = {}
): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: s.userId,
			accountId,
			categoryId: s.categoryId,
			date: new Date(`${over.date ?? '2026-03-10'}T00:00:00.000Z`),
			label: type === 'expense' ? 'VIR SEPA LIVRET A' : 'VIREMENT RECU',
			amountCents: BigInt(over.amountCents ?? 50000),
			type,
			source: 'csv'
		},
		select: { id: true }
	});
	return created.id;
}

async function linkOf(id: string): Promise<string | null> {
	const found = await prisma.transaction.findUniqueOrThrow({
		where: { id },
		select: { transferPairId: true }
	});
	return found.transferPairId;
}

describe('confirmTransferPair', () => {
	it('stores the link on both legs of two imported rows both stored positive', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income', { date: '2026-03-12' });

		expect(await confirmTransferPair(s.userId, out, into)).toEqual({ ok: true });

		expect([await linkOf(out), await linkOf(into)]).toEqual([into, out]);
	});

	it('refuses two expense ids with the reason, and writes nothing', async () => {
		const s = await seed();
		const a = await row(s, s.checking, 'expense');
		const b = await row(s, s.savings, 'expense');

		expect(await confirmTransferPair(s.userId, a, b)).toEqual({
			ok: false,
			reason: 'same-direction'
		});
		expect([await linkOf(a), await linkOf(b)]).toEqual([null, null]);
	});

	it("refuses another member's leg as not-found, the answer a missing id gets", async () => {
		const mine = await seed();
		const theirs = await seed();
		const out = await row(mine, mine.checking, 'expense');
		const foreign = await row(theirs, theirs.savings, 'income');

		const refused = await confirmTransferPair(mine.userId, out, foreign);
		const missing = await confirmTransferPair(mine.userId, out, 'c'.repeat(25));

		expect(refused).toEqual({ ok: false, reason: 'not-found' });
		expect(missing).toEqual(refused);
		expect([await linkOf(out), await linkOf(foreign)]).toEqual([null, null]);
	});

	it('refuses a leg that is already paired, and leaves the first pair intact', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		const other = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		expect(await confirmTransferPair(s.userId, out, other)).toEqual({
			ok: false,
			reason: 'already-paired'
		});
		expect([await linkOf(out), await linkOf(into), await linkOf(other)]).toEqual([into, out, null]);
	});
});

describe('undoTransferPairs', () => {
	it('clears both legs from either side', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		expect(await undoTransferPairs(s.userId, [into])).toEqual({ ok: true, unlinked: 1 });
		expect([await linkOf(out), await linkOf(into)]).toEqual([null, null]);
	});

	it("refuses another member's leg as not-found and leaves their pair intact", async () => {
		const mine = await seed();
		const theirs = await seed();
		const out = await row(theirs, theirs.checking, 'expense');
		const into = await row(theirs, theirs.savings, 'income');
		await confirmTransferPair(theirs.userId, out, into);

		expect(await undoTransferPairs(mine.userId, [out])).toEqual({ ok: false, reason: 'not-found' });
		expect([await linkOf(out), await linkOf(into)]).toEqual([into, out]);
	});
});

describe('undo against a partner that moved (passes 1189-code-1A N6, 1B N13)', () => {
	// The interleaving: undo(A) read A->B, then another request unlinked A-B and linked B to D.
	// What reaches the clearing step is the STALE partner; it must leave B-D mutual.
	it('clears nothing when the pair it read is no longer the pair stored', async () => {
		const s = await seed();
		const a = await row(s, s.checking, 'expense');
		const b = await row(s, s.savings, 'income');
		const d = await row(s, s.checking, 'expense', { date: '2026-03-11' });
		await confirmTransferPair(s.userId, a, b);
		await undoTransferPairs(s.userId, [b]);
		await confirmTransferPair(s.userId, d, b);

		const cleared = await prisma.$transaction((tx) => clearReadPair(tx, s.userId, a, b));

		expect(cleared).toBe(0);
		expect([await linkOf(a), await linkOf(b), await linkOf(d)]).toEqual([null, d, b]);
	});

	it('unlinks a whole list in one transaction, and a foreign id rolls the list back', async () => {
		const mine = await seed();
		const theirs = await seed();
		const out = await row(mine, mine.checking, 'expense');
		const into = await row(mine, mine.savings, 'income');
		const foreign = await row(theirs, theirs.checking, 'expense');
		await confirmTransferPair(mine.userId, out, into);

		expect(await undoTransferPairs(mine.userId, [out, foreign])).toEqual({
			ok: false,
			reason: 'not-found'
		});
		expect([await linkOf(out), await linkOf(into)]).toEqual([into, out]);
		expect(await undoTransferPairs(mine.userId, [out])).toEqual({ ok: true, unlinked: 1 });
		expect([await linkOf(out), await linkOf(into)]).toEqual([null, null]);
	});
});

describe('proposals and « Pair all »', () => {
	it('sorts the planted pair, the near-miss outside the window and the ambiguous leg', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense', { amountCents: 50000 });
		const into = await row(s, s.savings, 'income', { amountCents: 50000, date: '2026-03-12' });
		// Two days outside the window.
		const late = await row(s, s.checking, 'expense', { amountCents: 777 });
		await row(s, s.savings, 'income', {
			amountCents: 777,
			date: `2026-03-${10 + WINDOW_DAYS + 2}`
		});
		// One leg, two candidates.
		const twin = await row(s, s.checking, 'expense', { amountCents: 1200, date: '2026-03-05' });
		await row(s, s.savings, 'income', { amountCents: 1200, date: '2026-03-05' });
		const third = await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: s.userId,
				name: 'PEL',
				nameKey: computeNameKey('PEL'),
				source: 'csv'
			},
			select: { id: true }
		});
		await row(s, third.id, 'income', { amountCents: 1200, date: '2026-03-06' });

		const result = await listTransferProposals(s.userId, WINDOW_DAYS);

		expect(result.proposed).toEqual([[into, out].sort()]);
		expect(result.ambiguous).toContain(twin);
		expect(result.ambiguous).toHaveLength(3);
		expect(result.none).toContain(late);
		expect(result.none).toHaveLength(2);
	});

	it('pairs exactly the proposed set, recomputed on the server', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		const twin = await row(s, s.checking, 'expense', { amountCents: 1200 });
		await row(s, s.savings, 'income', { amountCents: 1200 });
		await row(s, s.savings, 'income', { amountCents: 1200, date: '2026-03-11' });

		expect(await pairAllProposed(s.userId, WINDOW_DAYS)).toEqual({
			paired: 1,
			pairedIds: [[into, out].sort()[0]]
		});
		expect([await linkOf(out), await linkOf(into), await linkOf(twin)]).toEqual([into, out, null]);
	});
});

describe('every path that breaks a pair clears the link', () => {
	it('deleting one leg leaves the other unlinked', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		await prisma.transaction.deleteMany({ where: { userId: s.userId, id: out } });

		expect(await linkOf(into)).toBeNull();
	});

	it('splitting a paired leg unlinks both legs', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense', { amountCents: 50000 });
		const into = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		const split = await replaceSplits(s.userId, out, [
			{ categoryId: s.categoryId, amountCents: 20000, note: '' },
			{ categoryId: s.categoryId, amountCents: 30000, note: '' }
		]);

		expect(split).toEqual({ ok: true });
		expect([await linkOf(out), await linkOf(into)]).toEqual([null, null]);
	});

	it('refuses to pair a leg split in a transaction that committed first', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense', { amountCents: 50000 });
		const into = await row(s, s.savings, 'income');
		await replaceSplits(s.userId, out, [
			{ categoryId: s.categoryId, amountCents: 20000, note: '' },
			{ categoryId: s.categoryId, amountCents: 30000, note: '' }
		]);

		expect(await confirmTransferPair(s.userId, out, into)).toEqual({ ok: false, reason: 'split' });
		expect([await linkOf(out), await linkOf(into)]).toEqual([null, null]);
	});

	// Pass 1189-note-1 N9: the split check must be read inside the confirm's own transaction. Run
	// unforced, alternating which call starts first, and the ORDER is read from what confirm
	// answered: the end state cannot tell it, because a split after a confirm clears the link too.
	it('never leaves a split leg paired when a split and a confirm race', async () => {
		const orders = { confirmFirst: 0, splitFirst: 0 };
		const RUNS = 20;
		for (let run = 0; run < RUNS; run += 1) {
			const s = await seed();
			const out = await row(s, s.checking, 'expense', { amountCents: 50000 });
			const into = await row(s, s.savings, 'income');
			const split = () =>
				replaceSplits(s.userId, out, [
					{ categoryId: s.categoryId, amountCents: 20000, note: '' },
					{ categoryId: s.categoryId, amountCents: 30000, note: '' }
				]);
			const confirm = () => confirmTransferPair(s.userId, out, into);
			const [confirmed] =
				run % 2 === 0
					? await Promise.all([confirm(), split()])
					: await Promise.all([split(), confirm()]).then(([, c]) => [c] as const);
			const splits = await prisma.transactionSplit.count({ where: { transactionId: out } });
			const link = await linkOf(out);
			const partner = await linkOf(into);
			expect(
				[splits > 0, link, partner],
				`run ${run}: the split landed and both legs are unlinked`
			).toEqual([true, null, null]);
			if (confirmed.ok) orders.confirmFirst += 1;
			else if (confirmed.reason === 'split') orders.splitFirst += 1;
		}
		// stdout directly: `console` is bridged into the structured logger, which a db-smoke does not print.
		process.stdout.write(
			`transfer-pair race orders over ${RUNS} runs: ${JSON.stringify(orders)}\n`
		);
		expect(orders.confirmFirst + orders.splitFirst).toBe(RUNS);
	});

	it('removing a member takes both legs without a foreign-key error', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		await prisma.user.delete({ where: { id: s.userId } });

		expect(await prisma.transaction.count({ where: { id: { in: [out, into] } } })).toBe(0);
	});

	// MySQL's own collation refuses the second account before it exists (crossProvider.db-smoke.ts),
	// so the merge cannot arise there.
	it.skipIf(process.env.DATABASE_PROVIDER === 'mysql')(
		'the start-up merge of two same-named accounts unlinks a pair it folds into one account',
		async () => {
			const s = await seed();
			const twinAccounts = await Promise.all(
				[
					['Compte joint', '2026-01-01'],
					['COMPTE JOINT', '2026-02-01']
				].map(([name, created]) =>
					prisma.account.create({
						data: {
							...DEFAULT_DENOMINATION,
							userId: s.userId,
							name,
							nameKey: null,
							source: 'csv',
							createdAt: new Date(`${created}T00:00:00.000Z`)
						},
						select: { id: true }
					})
				)
			);
			const out = await row(s, twinAccounts[0].id, 'expense');
			const into = await row(s, twinAccounts[1].id, 'income');
			const kept = await row(s, s.checking, 'expense', { amountCents: 900 });
			const keptPartner = await row(s, twinAccounts[1].id, 'income', { amountCents: 900 });
			await confirmTransferPair(s.userId, out, into);
			await confirmTransferPair(s.userId, kept, keptPartner);

			await runNameKeyBackfill({ prisma });

			expect([await linkOf(out), await linkOf(into)]).toEqual([null, null]);
			expect([await linkOf(kept), await linkOf(keptPartner)]).toEqual([keptPartner, kept]);
		}
	);
});

describe('a pair through a backup', () => {
	async function exported(userId: string) {
		return JSON.parse(JSON.stringify(await buildBackupExport(userId)));
	}

	it('comes back linked, under the ids the restore regenerated', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		await confirmTransferPair(s.userId, out, into);

		await restoreBackup(s.userId, backupExportSchema.parse(await exported(s.userId)));

		const rows = await prisma.transaction.findMany({
			where: { userId: s.userId },
			select: { id: true, type: true, transferPairId: true }
		});
		const [expense] = rows.filter((r) => r.type === 'expense');
		const [income] = rows.filter((r) => r.type === 'income');
		expect(rows).toHaveLength(2);
		expect(expense.transferPairId).toBe(income.id);
		expect(income.transferPairId).toBe(expense.id);
	});

	it('refuses a file whose link joins two expenses, naming the reason', async () => {
		const s = await seed();
		const a = await row(s, s.checking, 'expense');
		const b = await row(s, s.savings, 'expense');
		const file = await exported(s.userId);
		for (const t of file.transactions) t.transferPairId = t.id === a ? b : a;

		const attempt = restoreBackup(s.userId, backupExportSchema.parse(file));

		await expect(attempt).rejects.toBeInstanceOf(BackupImportError);
		await expect(attempt).rejects.toMatchObject({ reason: 'transfer_pair' });
		expect(await prisma.transaction.count({ where: { userId: s.userId } })).toBe(2);
	});

	it('refuses a file whose link is one-sided', async () => {
		const s = await seed();
		const out = await row(s, s.checking, 'expense');
		const into = await row(s, s.savings, 'income');
		const file = await exported(s.userId);
		for (const t of file.transactions) if (t.id === out) t.transferPairId = into;

		await expect(restoreBackup(s.userId, backupExportSchema.parse(file))).rejects.toMatchObject({
			reason: 'transfer_pair'
		});
	});
});
