import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { restoreBackup } from './import';
import { MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';
import type { BackupExport } from './schema';

/**
 * Two claims about a tagged restore that a fake Prisma structurally cannot answer.
 *
 * The first is cost. Every tagged transaction leaves the bulk `createMany` and gets its own
 * `create` inside the one interactive transaction (see the id-capture set in import.ts), because
 * `createMany` cannot return generated ids and a TransactionTag pair needs the new one. What that
 * costs is a database round trip, and the fake has none.
 *
 * The second is the cascade. `restoreBackup` deliberately has no `transactionTag.deleteMany` in
 * its purge block: the table carries no userId to scope one by, so the purge relies on the cascade
 * from both parents. The fake has no cascades either, so asserting that there would only prove the
 * fake. It is asserted here instead.
 *
 * See vitest.db.config.ts for how to run this.
 */

// Same guard as crossProvider.db-smoke.ts, and for the same reason: the app's client falls back to
// `file:./dev.db` when DATABASE_URL is unset, and this suite writes and deletes real rows.
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

/**
 * The criterion, fixed BEFORE the first run so a slow result is a finding rather than a number to
 * get used to.
 *
 * 5000 transactions is roughly a decade at 500 a year, every one of them tagged. 30 seconds is a
 * 4x margin against the 120 second LONG_TRANSACTION_OPTIONS ceiling, so a loaded CI runner or a
 * slower developer machine is not sitting at the edge.
 *
 * Over budget on any engine stops the PR. The measurement and a proposal go to the product owner.
 * Do not raise this number and do not add a cap: capping would reject a legal export.
 */
const TRANSACTION_COUNT = 5000;
const BUDGET_MS = 30_000;

const createdUserIds: string[] = [];

async function freshUser(): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `volume-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	return user.id;
}

/**
 * One account, one category, `count` transactions, one tag, and exactly one pair per transaction.
 *
 * The pair count is deliberately `count` rather than anything larger, so the payload stays inside
 * the relative bound the validator enforces (`count * MAX_TAGS_PER_TRANSACTION`). Referenced here
 * so the relationship between this fixture and that bound is visible rather than coincidental.
 */
function buildVolumePayload(count: number): BackupExport {
	const transactions = Array.from({ length: count }, (_, index) => ({
		id: `file-tx-${index}`,
		accountId: 'file-acc-1',
		categoryId: 'file-cat-1',
		importBatchId: null,
		date: new Date(2016, 0, 1 + index).toISOString(),
		label: `Transaction ${index}`,
		amountCents: -1_250,
		type: 'expense' as const,
		source: 'csv',
		notes: null,
		bankOperationType: null,
		manualCategory: null,
		natureManual: null,
		dedupeKey: `volume-dedupe-${index}`,
		metadataJson: null
	}));

	const pairs = transactions.map((transaction) => ({
		transactionId: transaction.id,
		tagId: 'file-clay'
	}));

	// One pair per transaction, against a ceiling of count * MAX_TAGS_PER_TRANSACTION. Asserted
	// rather than left as a comment: if the fixture ever outgrew the relative bound, the restore
	// would be refused by the validator and this file would be measuring a rejection rather than a
	// restore, while still reporting a very fast number.
	if (pairs.length > count * MAX_TAGS_PER_TRANSACTION) {
		throw new Error('volume fixture exceeds the relative bound the backup validator enforces');
	}

	return {
		formatVersion: 1,
		exportedAt: new Date(2026, 7, 2).toISOString(),
		userEmail: 'volume@budgetpilot.invalid',
		accounts: [{ id: 'file-acc-1', name: 'Compte courant', currency: 'EUR', source: 'csv' }],
		categories: [{ id: 'file-cat-1', name: 'Courses' }],
		importBatches: [],
		transactions,
		monthlyBudgets: [],
		categoryRules: [],
		categorizationRules: [],
		categoryNatureMappings: [],
		netWorthAccounts: [],
		netWorthSnapshots: [],
		savingsGoals: [],
		bankConnections: [],
		recurringStreamActions: [],
		tags: [{ id: 'file-clay', name: 'Portugal', colorToken: 'clay' }],
		transactionTags: pairs,
		transactionSplits: []
	} as BackupExport;
}

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('restore volume with tags', () => {
	it(`restores ${TRANSACTION_COUNT} tagged transactions within ${BUDGET_MS}ms`, async () => {
		expect.assertions(2);

		const userId = await freshUser();
		const payload = buildVolumePayload(TRANSACTION_COUNT);

		const startedAt = performance.now();
		await restoreBackup(userId, payload);
		const elapsedMs = performance.now() - startedAt;

		// Reported on every run, passing or not: the number is the deliverable, not the boolean.
		// Written straight to stdout rather than through console.*, which vitest intercepts and
		// does not surface in this config, so the measurement would be invisible exactly when it
		// is the whole point of the test.
		process.stdout.write(
			`\n[volume] ${process.env.DATABASE_PROVIDER ?? 'sqlite'}: ${TRANSACTION_COUNT} tagged ` +
				`transactions restored in ${Math.round(elapsedMs)}ms (budget ${BUDGET_MS}ms)\n`
		);

		const linkCount = await prisma.transactionTag.count({
			where: { transaction: { userId } }
		});
		expect(linkCount).toBe(TRANSACTION_COUNT);
		expect(elapsedMs).toBeLessThan(BUDGET_MS);
	}, 180_000);
});

describe('restore purge and the join table', () => {
	it('leaves no orphan link behind, because both parents cascade', async () => {
		expect.assertions(3);

		const userId = await freshUser();

		// First restore: creates the tag, the transaction and the link.
		await restoreBackup(userId, buildVolumePayload(1));
		expect(await prisma.transactionTag.count({ where: { transaction: { userId } } })).toBe(1);

		const linkedTagIds = (
			await prisma.tag.findMany({ where: { userId }, select: { id: true } })
		).map((tag) => tag.id);

		// Second restore of a payload with NO tags. The purge block deletes transactions and tags
		// but never touches TransactionTag, so if either cascade were missing this would either
		// leave an orphan row or fail on a foreign key.
		const empty = buildVolumePayload(1);
		empty.tags = [];
		empty.transactionTags = [];
		await restoreBackup(userId, empty);

		expect(await prisma.transactionTag.count({ where: { transaction: { userId } } })).toBe(0);
		// Nothing survives pointing at the tags the purge removed, on any engine.
		expect(await prisma.transactionTag.count({ where: { tagId: { in: linkedTagIds } } })).toBe(0);
	});
});
