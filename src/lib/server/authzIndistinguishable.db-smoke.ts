import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { prisma } from '$lib/server/db';
import { EVENT } from '$lib/server/logging/names';

/**
 * L4a contract invariant 2, against a real engine: a reference owned by ANOTHER account and a
 * reference that does not exist give the same answer AND the same `authz_fail` line, and the other
 * account's row survives. AGENTS.md: an object reference a client posts is asserted in db-smoke,
 * never only in a unit spec, because a unit spec's fake decides what the lookup returns.
 *
 * Three sites, one per shape of refusal: an inline route `fail(404)` (the transaction delete), a
 * service that throws `error(404)` (the budget delete), and a service that returns a not-found
 * sentinel the route maps to 404 (the tag rename). Each is driven through its REAL action.
 *
 * WHAT EACH TEST SEPARATES. « foreign and missing are indistinguishable, and both are logged »
 * from three failures: a refusal that writes no line (today), a line that differs between the two
 * (a second lookup without userId telling them apart, #830), and an answer that differs. The line
 * count per request is asserted beside the equality, because two empty captures are deep-equal.
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

type Line = { event: string; attributes: Record<string, unknown> };
const logged = vi.hoisted(() => [] as Line[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: Line) => {
		logged.push(event);
	}
}));

const created: string[] = [];

beforeAll(() => {
	// The log pseudonyms derive their keys from this secret and refuse any other shape.
	env.RATE_LIMIT_HASH_SECRET = 'f6'.repeat(32);
});

beforeEach(() => {
	logged.length = 0;
});

afterAll(async () => {
	// Every row below cascades from User.
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

async function seedUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `authz-smoke-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true, email: true }
	});
	created.push(user.id);
	return { id: user.id, email: user.email, role: 'USER' as const };
}

/** A well-formed id no row holds: past `normalizeId`, so the lookup itself is what refuses it. */
function missingId(): string {
	return `cmissing${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function form(fields: Record<string, string>, path: string): Request {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return new Request(`http://localhost${path}`, { method: 'POST', body });
}

/** One request's answer, reduced to what a client receives, and the authz_fail lines it wrote. */
async function attempt(run: () => Promise<unknown>) {
	logged.length = 0;
	const answer = (await run()) as { status?: number; data?: unknown };
	return {
		answer: { status: answer.status, data: answer.data },
		lines: logged.filter((line) => line.event === EVENT.authzFail).map((line) => line.attributes)
	};
}

function verdict(foreign: Awaited<ReturnType<typeof attempt>>, missing: typeof foreign) {
	return {
		foreignLines: foreign.lines.length,
		missingLines: missing.lines.length,
		sameAnswer: JSON.stringify(foreign.answer) === JSON.stringify(missing.answer),
		sameLine: JSON.stringify(foreign.lines) === JSON.stringify(missing.lines)
	};
}

const INDISTINGUISHABLE = { foreignLines: 1, missingLines: 1, sameAnswer: true, sameLine: true };

describe('L4a: a foreign reference and a missing one are indistinguishable, answer and line', () => {
	// Calibration of the capture: a line written through the module the routes import lands in
	// `logged`, so a zero below cannot come from a mock wired to nothing.
	it('captures a line written through the logging module the routes import', async () => {
		const { log } = await import('$lib/server/logging');
		log({ event: EVENT.configOriginUnset, attributes: {} } as never);
		expect(logged.map((line) => line.event)).toEqual([EVENT.configOriginUnset]);
	});

	it('the transaction delete (inline fail(404))', async () => {
		const a = await seedUser('tx-a');
		const b = await seedUser('tx-b');
		const account = await prisma.account.create({
			data: { ...DEFAULT_DENOMINATION, userId: b.id, name: 'Compte courant', source: 'manual' },
			select: { id: true }
		});
		const category = await prisma.category.create({
			data: { userId: b.id, name: 'Courses' },
			select: { id: true }
		});
		const foreign = await prisma.transaction.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: b.id,
				accountId: account.id,
				categoryId: category.id,
				date: new Date('2026-06-15T00:00:00.000Z'),
				label: 'authz smoke',
				amountCents: -4_200,
				source: 'manual'
			},
			select: { id: true }
		});

		const { actions } = await import('../../routes/transactions/+page.server');
		const remove = actions.deleteTransaction as unknown as (event: unknown) => Promise<unknown>;
		const post = (transactionId: string) =>
			attempt(() =>
				remove({ locals: { user: a }, request: form({ transactionId }, '/transactions') })
			);

		const onForeign = await post(foreign.id);
		const onMissing = await post(missingId());
		expect({
			...verdict(onForeign, onMissing),
			status: onForeign.answer.status,
			foreignKept: (await prisma.transaction.count({ where: { id: foreign.id } })) === 1
		}).toEqual({ ...INDISTINGUISHABLE, status: 404, foreignKept: true });
	});

	it('the budget delete (service throws error(404))', async () => {
		const a = await seedUser('budget-a');
		const b = await seedUser('budget-b');
		const foreign = await prisma.monthlyBudget.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: b.id,
				categoryName: 'Courses',
				categoryNameKey: 'courses',
				amountCents: 25_000n
			},
			select: { id: true }
		});

		const { actions } = await import('../../routes/budgets/+page.server');
		const remove = actions.delete as unknown as (event: unknown) => Promise<unknown>;
		const post = (id: string) =>
			attempt(() => remove({ locals: { user: a }, request: form({ id }, '/budgets') }));

		const onForeign = await post(foreign.id);
		const onMissing = await post(missingId());
		expect({
			...verdict(onForeign, onMissing),
			status: onForeign.answer.status,
			foreignKept: (await prisma.monthlyBudget.count({ where: { id: foreign.id } })) === 1
		}).toEqual({ ...INDISTINGUISHABLE, status: 404, foreignKept: true });
	});

	it('the tag rename (service returns not-found, route maps it to 404)', async () => {
		const a = await seedUser('tag-a');
		const b = await seedUser('tag-b');
		const foreign = await prisma.tag.create({
			data: { userId: b.id, name: 'Portugal', nameKey: 'portugal', colorToken: 'lagoon' },
			select: { id: true }
		});

		const { actions } = await import('../../routes/settings/+page.server');
		const rename = actions.renameTag as unknown as (event: unknown) => Promise<unknown>;
		const post = (id: string) =>
			attempt(() =>
				rename({
					locals: { user: a },
					request: form({ id, newName: 'Espagne' }, '/settings')
				})
			);

		const onForeign = await post(foreign.id);
		const onMissing = await post(missingId());
		const kept = await prisma.tag.findUnique({ where: { id: foreign.id }, select: { name: true } });
		expect({
			...verdict(onForeign, onMissing),
			status: onForeign.answer.status,
			foreignKeptItsName: kept?.name
		}).toEqual({ ...INDISTINGUISHABLE, status: 404, foreignKeptItsName: 'Portugal' });
	});
});
