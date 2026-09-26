import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `init` runs the boot collector, awaits it, and stops the boot on its refusal (#738).
 *
 * This link used to be a source scan for `await assertEnvironmentConfigured()` over
 * `hooks.server.ts`, in the xlsx and backup bounds' specs: calibrated, but a proxy, satisfied by
 * the text in a comment or in a function `init` never calls. Here `init` itself is called with the
 * collector and every later boot step replaced by spies, so what is asserted is what `init` DOES.
 *
 * The later steps are spied rather than run because each one reads or writes the database, and
 * the property under test is the order and the stop, not what they do.
 */
const boot = vi.hoisted(() => {
	const calls: string[] = [];
	const step = (name: string) =>
		vi.fn(async () => {
			calls.push(name);
		});
	return {
		calls,
		assertEnvironmentConfigured: vi.fn(async () => {
			calls.push('assertEnvironmentConfigured');
		}),
		warnIfDatabaseRoleIsOverprivileged: step('warnIfDatabaseRoleIsOverprivileged'),
		ensureNameKeysBackfilled: step('ensureNameKeysBackfilled'),
		ensureDedupeKeyHashesBackfilled: step('ensureDedupeKeyHashesBackfilled'),
		ensureDedupeKeysAtCurrentVersion: step('ensureDedupeKeysAtCurrentVersion'),
		ensureStatementAccountsBackfilled: step('ensureStatementAccountsBackfilled'),
		ensureNoContestedNetWorthLinks: step('ensureNoContestedNetWorthLinks')
	};
});

vi.mock('$lib/server/env/assertConfigured', () => ({
	assertEnvironmentConfigured: boot.assertEnvironmentConfigured
}));
vi.mock('$lib/server/database/privileges', () => ({
	warnIfDatabaseRoleIsOverprivileged: boot.warnIfDatabaseRoleIsOverprivileged
}));
vi.mock('$lib/server/naming/boot', () => ({
	ensureNameKeysBackfilled: boot.ensureNameKeysBackfilled
}));
vi.mock('$lib/server/import/dedupeBoot', () => ({
	ensureDedupeKeyHashesBackfilled: boot.ensureDedupeKeyHashesBackfilled,
	ensureDedupeKeysAtCurrentVersion: boot.ensureDedupeKeysAtCurrentVersion
}));
vi.mock('$lib/server/import/accountBoot', () => ({
	ensureStatementAccountsBackfilled: boot.ensureStatementAccountsBackfilled
}));
vi.mock('$lib/server/net-worth/contestedBoot', () => ({
	ensureNoContestedNetWorthLinks: boot.ensureNoContestedNetWorthLinks
}));
// Nothing here opens a database; the mock only keeps the module graph from constructing a client.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const { init } = await import('./hooks.server');

beforeEach(() => {
	boot.calls.length = 0;
});

describe('init, the server start', () => {
	// Break-checked on 2026-09-25, one clause each, separately, each red on this file:
	// - the collector call deleted from `init` (the link exists vs not): both red, the first
	//   step is `warnIfDatabaseRoleIsOverprivileged` and the refusal's `outcome` is `started`;
	// - its `await` removed (awaited vs fired and forgotten): the refusal test red, `outcome` is
	//   `started` and every later step ran while the refusal was still pending;
	// - the call moved below `warnIfDatabaseRoleIsOverprivileged` (first vs not first): both red,
	//   that step running before the collector.

	it('runs the collector first, then every later boot step, when the configuration is sound', async () => {
		// The presence half, and the calibration of the one below: without it, `ran` listing only
		// the collector would also be the output of spies that record nothing.
		// The later steps are read from the spies above rather than retyped, and compared as a set:
		// their order among themselves is `hooks.server.ts`'s to document, not this file's claim.
		const later = Object.keys(boot).filter(
			(name) => name !== 'calls' && name !== 'assertEnvironmentConfigured'
		);

		await init();

		expect({ first: boot.calls[0], later: boot.calls.slice(1).toSorted() }).toStrictEqual({
			first: 'assertEnvironmentConfigured',
			later: later.toSorted()
		});
	});

	it("refuses to start with the collector's own report, before any step that reads the database", async () => {
		// The refusal is the collector's error object itself, so the operator reads the report it
		// built rather than something `init` wrapped around it. Compared by identity.
		const refusal = new Error('BudgetPilot cannot start: one configuration problem.');
		boot.assertEnvironmentConfigured.mockImplementationOnce(async () => {
			boot.calls.push('assertEnvironmentConfigured');
			throw refusal;
		});

		let outcome: unknown = 'started';
		try {
			await init();
		} catch (caught) {
			outcome = caught === refusal ? 'refused with the collector report' : caught;
		}

		// One value, so the outcome and the steps that ran are both shown whichever is red.
		expect({ outcome, ran: [...boot.calls] }).toStrictEqual({
			outcome: 'refused with the collector report',
			ran: ['assertEnvironmentConfigured']
		});
	});
});
