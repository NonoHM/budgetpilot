import { prisma } from '$lib/server/db';
import { resolveDatabaseProvider, type DatabaseEnv } from './provider.ts';

/**
 * What the catalog query answers: does this connection hold more than ownership of its own
 * database, and does it own that database at all.
 */
export interface DatabaseRoleFacts {
	/** Superuser, or a member of a role that grants server-side program/file execution. */
	overprivileged: boolean;
	/** The app's role owns the database it is connected to. */
	ownsDatabase: boolean;
	/** The app's role is the cluster's bootstrap superuser, which cannot give up the attribute. */
	isBootstrapRole: boolean;
}

/**
 * Warns at startup when the app holds more PostgreSQL privilege than it uses.
 *
 * The app needs to own one database. A superuser — or a member of
 * `pg_execute_server_program` — can also `COPY … TO PROGRAM`, which turns any future foothold
 * in the app into command execution on the database host. That is a privilege the app never
 * exercises and cannot drop for itself once connected.
 *
 * The bundled overlay no longer hands it one: `docker-compose.postgres.yml` creates a plain
 * login role at initdb time and gives it ownership of the database. Two cases still reach this
 * check, and neither is visible any other way:
 *
 * - a data volume created before that overlay existed, where the app's role IS the cluster's
 *   bootstrap superuser;
 * - an operator's own server, where the account was granted more than it needs.
 *
 * A warning rather than a refusal to start, deliberately. Both cases are instances that work
 * today, and the second is a server this app does not administer: crashing it over a privilege
 * it cannot fix would break a running install to protect against a second-order risk, which is
 * a worse failure than the one being reported. The default is secure and the exception is loud
 * — the same shape as the `PUBLIC_INSTANCE=false` warning next to it in hooks.server.ts.
 *
 * The advice branches on what the connection actually is, because one sentence cannot be right
 * for all of them: `ALTER ROLE … NOSUPERUSER` is refused outright on the bootstrap superuser,
 * and on a role that does not own its database it would take away the privilege the app has
 * been relying on to write at all.
 *
 * MySQL/MariaDB has no equivalent check because it has no equivalent default: the image's
 * `MARIADB_USER` is scoped to `MARIADB_DATABASE` from the start.
 *
 * Never fatal for its own reasons either. A cluster that refuses the catalog read must not
 * stop the app from booting, so the failure is swallowed: this function reports a privilege,
 * it does not gate one.
 */
export async function warnIfDatabaseRoleIsOverprivileged(
	env: DatabaseEnv = process.env,
	readRoleFacts: () => Promise<unknown> = readRoleFactsFromPostgres
): Promise<void> {
	if (resolveDatabaseProvider(env) !== 'postgresql') return;

	let rows: unknown;
	try {
		rows = await readRoleFacts();
	} catch {
		return;
	}

	const facts = parseRoleFacts(rows);
	if (!facts?.overprivileged) return;

	console.warn(
		`[budgetpilot] ⚠️ SECURITY: this app connects to PostgreSQL with more privilege than it ` +
			`uses — it needs to own its own database and nothing more, and it currently also has ` +
			`the rights that allow running programs on the database host. ${remediationFor(facts)} ` +
			`See docs/database-providers.md, "The app's database account".`
	);
}

/**
 * One statement, through the tagged-template API so that no string can ever be interpolated
 * into it — `$queryRawUnsafe` would leave that door open for the next edit, and this is the
 * only raw query in the codebase.
 *
 * `rolsuper` on `current_user` alone would miss the two ways to reach `COPY … TO PROGRAM`
 * without the attribute: membership in `pg_execute_server_program` (or the file-access roles
 * beside it), and membership in a superuser role, which is one `SET ROLE` away. `pg_has_role`
 * with `MEMBER` covers both, including a `NOINHERIT` membership that is not active right now.
 *
 * `oid = 10` is the bootstrap superuser — the role initdb created the cluster with. It is
 * singled out because PostgreSQL refuses to remove `SUPERUSER` from it under any
 * circumstances, so the advice for that case has to be a different sentence.
 *
 * The other two facts are asked about the connected role ITSELF, not about the membership set
 * the first one scans, and that separation is load-bearing: a superuser is implicitly a member
 * of every role in the cluster, so `pg_has_role` answers true for the bootstrap role and for
 * the database owner no matter who is asking. Written as one scan, the check told a plain
 * superuser it was the bootstrap role — observed on a live stack, where the fix it printed was
 * the one fix that could not apply to it.
 */
function readRoleFactsFromPostgres(): Promise<unknown> {
	return prisma.$queryRaw`
		SELECT
			(
				SELECT bool_or(
					r.rolsuper
					OR r.rolname IN (
						'pg_execute_server_program',
						'pg_write_server_files',
						'pg_read_server_files'
					)
				)
				FROM pg_roles r
				WHERE pg_has_role(current_user, r.oid, 'MEMBER')
			) AS overprivileged,
			(SELECT oid = 10 FROM pg_roles WHERE rolname = current_user) AS is_bootstrap_role,
			(
				SELECT datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
				FROM pg_database
				WHERE datname = current_database()
			) AS owns_database
	`;
}

/** The one sentence that is true for this particular connection. */
function remediationFor(facts: DatabaseRoleFacts): string {
	if (facts.isBootstrapRole) {
		return (
			"This role is the cluster's bootstrap superuser, which PostgreSQL will not let you " +
			'demote — "ALTER ROLE … NOSUPERUSER" is refused on it. Give the app a role of its ' +
			"own instead: CREATE ROLE budgetpilot_app LOGIN PASSWORD '…'; ALTER DATABASE " +
			'<database> OWNER TO budgetpilot_app; then point DATABASE_URL at it. Under the ' +
			'bundled overlay, the equivalent is a dump, a fresh volume, and a restore.'
		);
	}
	if (!facts.ownsDatabase) {
		return (
			'This role does not own the database it writes to, so it is that extra privilege ' +
			'that lets it write at all: hand it ownership first (ALTER DATABASE <database> ' +
			'OWNER TO "<this role>"), then remove the excess (ALTER ROLE "<this role>" ' +
			'NOSUPERUSER, and REVOKE any pg_execute_server_program membership).'
		);
	}
	return (
		'It already owns its database, so removing the excess changes nothing it uses: ' +
		'ALTER ROLE "<this role>" NOSUPERUSER; and REVOKE any pg_execute_server_program, ' +
		'pg_write_server_files or pg_read_server_files membership.'
	);
}

/**
 * Reads the row the query returns, defensively.
 *
 * `$queryRaw` returns whatever the driver made of it, and the check has to answer with no
 * false alarm on a shape it did not expect — a warning that cries wolf is a warning operators
 * learn to skip. Anything that is not an explicit true reads as false, which is also what
 * `bool_or` over an empty set (SQL NULL) means here.
 */
function parseRoleFacts(rows: unknown): DatabaseRoleFacts | null {
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const row = rows[0] as Record<string, unknown> | null;
	if (!row) return null;

	return {
		overprivileged: isTrue(row.overprivileged),
		ownsDatabase: isTrue(row.owns_database),
		isBootstrapRole: isTrue(row.is_bootstrap_role)
	};
}

/** Postgres BOOLEAN arrives as a JS boolean; the string forms are a text-mode fallback. */
function isTrue(value: unknown): boolean {
	return value === true || value === 't' || value === 'true';
}
