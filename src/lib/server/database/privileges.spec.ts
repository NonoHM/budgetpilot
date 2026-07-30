import { afterEach, describe, expect, it, vi } from 'vitest';
import { warnIfDatabaseRoleIsOverprivileged } from './privileges';

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

function warnSpy() {
	return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('warnIfDatabaseRoleIsOverprivileged', () => {
	it('stays quiet on the posture the bundled overlay produces', async () => {
		const warn = warnSpy();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts()
		);

		expect(warn).not.toHaveBeenCalled();
	});

	it('warns when the role owns its database but holds more than that', async () => {
		const warn = warnSpy();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true })
		);

		expect(warn).toHaveBeenCalledOnce();
		const message = warn.mock.calls[0][0] as string;
		expect(message).toContain('NOSUPERUSER');
		expect(message).toContain('already owns its database');
	});

	it('does not tell the bootstrap superuser to demote itself, which PostgreSQL refuses', async () => {
		const warn = warnSpy();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true, is_bootstrap_role: true })
		);

		const message = warn.mock.calls[0][0] as string;
		expect(message).toContain('bootstrap superuser');
		expect(message).toContain('Give the app a role of its own');
		// The statement PostgreSQL refuses on this role must not be what the operator is told
		// to run: following it produces "permission denied to alter role" and no way forward.
		expect(message).not.toContain('ALTER ROLE "<this role>" NOSUPERUSER');
	});

	it('tells a role that does not own its database to take ownership first', async () => {
		const warn = warnSpy();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true, owns_database: false })
		);

		const message = warn.mock.calls[0][0] as string;
		expect(message).toContain('does not own the database');
		expect(message).toContain('OWNER TO');
	});

	it('catches the privileges that grant COPY … TO PROGRAM without the superuser attribute', async () => {
		const warn = warnSpy();

		// What the query returns for a role that is merely a member of
		// pg_execute_server_program: not a superuser, still able to run programs.
		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: true })
		);

		expect(warn).toHaveBeenCalledOnce();
	});

	it('accepts the string forms a text-mode driver would return', async () => {
		const warn = warnSpy();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () =>
			facts({ overprivileged: 't' })
		);

		expect(warn).toHaveBeenCalledOnce();
	});

	it('never queries a provider that has no such concept', async () => {
		const warn = warnSpy();
		const read = vi.fn();

		await warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'mysql' }, read);
		await warnIfDatabaseRoleIsOverprivileged({}, read);

		expect(read).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('does not stop the boot when the catalog read fails', async () => {
		const warn = warnSpy();

		await expect(
			warnIfDatabaseRoleIsOverprivileged({ DATABASE_PROVIDER: 'postgresql' }, async () => {
				throw new Error('permission denied for table pg_roles');
			})
		).resolves.toBeUndefined();

		expect(warn).not.toHaveBeenCalled();
	});

	it('treats an unexpected result shape as "nothing to report" rather than warning', async () => {
		const warn = warnSpy();

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

		expect(warn).not.toHaveBeenCalled();
	});
});
