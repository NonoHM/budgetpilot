import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '$lib/server/db';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { toNullableMinorUnits } from './minorUnits.ts';

/**
 * What the money-column seam actually does, against a real engine.
 *
 * The compile-time answer is wrong in one of these cases and absent in another, so nothing here
 * can be asserted with a type. `moneyColumns.spec.ts` holds the source gates; this file holds the
 * only checks that can tell a `number` from a `bigint` at all.
 *
 * On a real engine and not a fake, for the reason `paging.db-smoke.ts` gives one file over: what a
 * driver hands back for a 64-bit column is the driver's answer, and a fake would be asserting the
 * fake's.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

/**
 * Past a signed 32-bit column and inside what a `number` holds exactly.
 *
 * This is the value the widening exists for: `domain/netWorth.ts` caps net worth at 1e9 minor
 * units, which at exponent 3 is 1e10 and about five times an `Int`. Storing and reading it is the
 * whole claim.
 */
const PAST_INT32 = 10_000_000_000;

let userId: string;
let accountId: string;
let categoryId: string;

beforeAll(async () => {
	const user = await prisma.user.create({
		data: {
			email: `money-columns-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
	const account = await prisma.account.create({
		data: { ...DEFAULT_DENOMINATION, userId, name: 'Money columns smoke account' },
		select: { id: true }
	});
	accountId = account.id;
	const category = await prisma.category.create({
		data: { userId, name: 'Money columns smoke category' },
		select: { id: true }
	});
	categoryId = category.id;
});

describe('a money column as the application receives it', () => {
	it('reads back as a number, at a magnitude an Int column could not have held', async () => {
		expect.assertions(3);

		const created = await prisma.transaction.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId,
				accountId,
				categoryId,
				date: new Date('2026-08-21T00:00:00.000Z'),
				label: 'past int32',
				amountCents: PAST_INT32,
				type: 'income',
				source: 'manual'
			},
			select: { id: true, amountCents: true }
		});

		expect(typeof created.amountCents).toBe('number');
		expect(created.amountCents).toBe(PAST_INT32);
		// The value, not just the type: a 32-bit column would have refused it or wrapped it, and
		// either way this is the assertion that says the widening reached the database rather than
		// only the schema file.
		const reread = await prisma.transaction.findUniqueOrThrow({
			where: { id: created.id },
			select: { amountCents: true }
		});
		expect(reread.amountCents).toBe(PAST_INT32);
	});

	it('survives JSON.stringify, which is what the backup export does with it', async () => {
		expect.assertions(1);

		const row = await prisma.transaction.findFirstOrThrow({
			where: { userId },
			select: { id: true, amountCents: true }
		});

		// `JSON.stringify` THROWS on a bigint rather than rendering it oddly, so this is a real
		// assertion about the extension and not a formatting preference. Unnarrowed, the whole
		// backup export fails with "Do not know how to serialize a BigInt".
		expect(() => JSON.stringify(row)).not.toThrow();
	});

	it('is narrowed inside an interactive transaction too', async () => {
		expect.assertions(1);

		const kind = await prisma.$transaction(async (tx) => {
			const row = await tx.transaction.findFirstOrThrow({
				where: { userId },
				select: { amountCents: true }
			});
			return typeof row.amountCents;
		});

		expect(kind).toBe('number');
	});
});

describe('the shape the extension does not reach', () => {
	// The trap, pinned. This assertion exists to FAIL if a future Prisma routes aggregates through
	// result extensions: at that point the narrowing calls in totals.ts and collision.ts become
	// redundant rather than load-bearing, and whoever reads this will know why they are there.
	it('returns an aggregate that is NOT narrowed, which is why the call sites narrow by hand', async () => {
		expect.assertions(2);

		const aggregate = await prisma.transaction.aggregate({
			where: { userId },
			_sum: { amountCents: true }
		});

		// Typed `number | null` by Prisma and `bigint` at run time. If this ever reads 'number',
		// Prisma changed and the hand-narrowing can go.
		expect(typeof aggregate._sum.amountCents).toBe('bigint');
		// And the narrowing call the production sites use turns it into the right number.
		expect(toNullableMinorUnits(aggregate._sum.amountCents, 'Transaction.amountCents')).toBe(
			PAST_INT32
		);
	});
});
