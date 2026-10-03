import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';
import { warnIfDatabaseRoleIsOverprivileged } from './privileges';

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

/** The catalog query's single row, in the shape the driver adapter returns it. */
function facts(overrides: Record<string, unknown> = {}) {
	return [
		{
			overprivileged: false,
			is_bootstrap_role: false,
			owns_database: true,
			...overrides
		}
	];
}

/** The one event the check logs, carrying the two facts that select a fix in the docs. */
function overprivileged(ownsDatabase: boolean, bootstrapRole: boolean) {
	return {
		event: EVENT.databaseOverprivileged,
		attributes: {
			[ATTRIBUTE.databaseOwnsDatabase]: ownsDatabase,
			[ATTRIBUTE.databaseBootstrapRole]: bootstrapRole
		}
	};
}

beforeEach(() => {
	logged.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('warnIfDatabaseRoleIsOverprivileged', () => {
	it('stays quiet on the posture the bundled overlay produces', async () => {
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts()
		);

		expect(logged).toEqual([]);
	});

	// The three tests below used to compare the remediation sentence. The SQL moved to
	// docs/database-providers.md, « The app's database account », which selects one of three fixes
	// by these two facts; so each case now asserts the facts that select its fix.
	it('warns when the role owns its database but holds more than that, saying it owns it', async () => {
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true })
		);

		expect(logged).toEqual([overprivileged(true, false)]);
	});

	it('marks the bootstrap superuser, so the docs do not tell it to demote itself, which PostgreSQL refuses', async () => {
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true, is_bootstrap_role: true })
		);

		// The statement PostgreSQL refuses on this role must not be what the operator is told
		// to run: following it produces "permission denied to alter role" and no way forward.
		// bootstrap_role true is what sends the reader to the separate-role fix instead.
		expect(logged).toEqual([overprivileged(true, true)]);
	});

	it('marks a role that does not own its database, so the docs say to take ownership first', async () => {
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true, owns_database: false })
		);

		expect(logged).toEqual([overprivileged(false, false)]);
	});

	it('catches the privileges that grant COPY … TO PROGRAM without the superuser attribute', async () => {
		// What the query returns for a role that is merely a member of
		// pg_execute_server_program: not a superuser, still able to run programs.
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true })
		);

		expect(logged).toEqual([overprivileged(true, false)]);
	});

	it('accepts the string forms a text-mode driver would return', async () => {
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: 't', owns_database: 'true', is_bootstrap_role: 't' })
		);

		expect(logged).toEqual([overprivileged(true, true)]);
	});

	it('never queries a provider that has no such concept', async () => {
		const read = vi.fn();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'mysql' }, read);
		await warnIfDatabaseRoleIsOverprivileged({}, read);

		expect(read).not.toHaveBeenCalled();
		expect(logged).toEqual([]);
	});

	it('does not stop the boot when the catalog read fails', async () => {
		await expect(
			warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () => {
				throw new Error('permission denied for table pg_roles');
			})
		).resolves.toBeUndefined();

		expect(logged).toEqual([]);
	});

	it('treats an unexpected result shape as "nothing to report" rather than warning', async () => {
		for (const result of [
			[],
			null,
			undefined,
			[{}],
			[null],
			'nope',
			facts({ overprivileged: 1 })
		]) {
			await warnIfDatabaseRoleIsOverprivileged(
				{ DATABASE_PROVIDER: 'postgresql' },
				async () => result
			);
		}

		expect(logged).toEqual([]);
	});
});
