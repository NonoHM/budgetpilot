/**
 * Making an upsert survive a concurrent writer.
 *
 * A Prisma `upsert` is not an atomic statement. Prisma compiles it down to a single
 * `INSERT ... ON CONFLICT DO UPDATE` only when a set of conditions hold, and otherwise falls
 * back to a `SELECT` followed by an `INSERT` when the select came back empty. Two callers
 * upserting the same row at the same time then both reach the insert, and the loser gets a
 * unique-constraint violation for a row it was perfectly happy to find already there.
 *
 * All of this was observed, not reasoned about, by running the cross-provider suite against
 * real servers (see crossProvider.db-smoke.ts):
 *
 * - On PostgreSQL the fallback is chosen whenever `update` is empty. Every get-or-create here
 *   passes `update: {}` deliberately, so that an import announcing "COURSES" never rewrites the
 *   category the user named "Courses" — which is exactly what disqualifies the atomic form.
 * - On MySQL and MariaDB the fallback was chosen for every folded upsert tried, including ones
 *   with a non-empty `update`. So the shape of the update is not something to rely on.
 * - Once the unique violation is retried, MariaDB surfaces a second, different failure under
 *   heavier contention: `Record has changed since last read`, its own transient write conflict,
 *   whose message literally asks the caller to try again.
 *
 * SQLite showed none of it, because it serializes writers. That is why none of this surfaced
 * until a second engine was in the picture, and why the rule is now simply: any upsert two
 * requests can reach at once goes through this function.
 *
 * ONLY for idempotent writes. Retrying is safe here because an upsert asks for an end state
 * ("this row exists, with this value") rather than for an increment or an append, so running it
 * twice lands where running it once would. Never wrap a write that is not idempotent.
 *
 * Must never run inside a `prisma.$transaction`. PostgreSQL aborts the enclosing transaction
 * when a constraint fires, so the retry would fail too, on a different error, and every later
 * statement with it.
 */

/** Attempts in total, not retries. Contention this deep is a stress test, not a user. */
const MAX_ATTEMPTS = 4;

/**
 * Engine-level codes meaning "you and someone else collided, try again".
 *
 * Deliberately an allowlist of specific codes rather than a catch-all on Prisma's P2039, which
 * is its generic wrapper for any driver error: retrying on that would silently re-run a write
 * after failures that have nothing to do with contention.
 */
const TRANSIENT_DRIVER_CODES = new Set([
	// MySQL / MariaDB: record changed since last read, deadlock.
	'1020',
	'1213',
	// PostgreSQL: serialization failure, deadlock detected.
	'40001',
	'40P01'
]);

// Deliberately absent: MySQL's 1205, lock wait timeout. It belongs to the same family, but it
// is the only one that fails slowly — `innodb_lock_wait_timeout` defaults to 50 seconds, so
// retrying it would turn one 50-second stall into four, holding a request and its pool
// connection for minutes. Every code above fails immediately, which is what makes retrying them
// free. A lock wait that long is a problem to surface, not to sit through again.

/** Prisma's unique-constraint violation, by its stable error code. */
export function isUniqueConstraintViolation(caught: unknown): boolean {
	return errorCodeOf(caught) === 'P2002';
}

/**
 * Prisma's foreign-key violation.
 *
 * NOT a transient write conflict, and deliberately not in the retry set above: it means a row
 * this write depends on does not exist, which is usually a bug rather than contention. It is
 * exported because there is one place where it IS contention: a row resolved a moment ago can be
 * deleted by a concurrent garbage-collector before the dependent insert lands. See
 * server/tags/service.ts, where that race was observed on a real engine rather than predicted.
 */
export function isForeignKeyViolation(caught: unknown): boolean {
	return errorCodeOf(caught) === 'P2003';
}

/**
 * Prisma's "a record this operation depends on was not found" (P2025).
 *
 * Raised by an UPSERT when its fallback SELECT found a row and the following UPDATE then matched
 * nothing, because someone deleted it in between: "No record was found for an upsert." Like P2003
 * it is NOT in the transient allowlist above, since for most callers it means a genuine
 * precondition failure rather than contention.
 *
 * Exported for the one place where it IS contention, and where it is the third distinct engine
 * manifestation of a single race: see server/tags/service.ts, whose auto-GC can delete a tag
 * mid-upsert. Found on PostgreSQL by CI, not by reasoning.
 */
export function isMissingRecord(caught: unknown): boolean {
	return errorCodeOf(caught) === 'P2025';
}

function errorCodeOf(caught: unknown): string | undefined {
	if (typeof caught !== 'object' || caught === null || !('code' in caught)) return undefined;
	const code = (caught as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

/** The driver's own code, when Prisma wrapped one. */
function driverCodeOf(caught: unknown): string | undefined {
	const meta = (caught as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } })?.meta;
	const code = meta?.driverAdapterError?.cause?.code;
	return code === undefined || code === null ? undefined : String(code);
}

function isRetryableWriteConflict(caught: unknown): boolean {
	const code = errorCodeOf(caught);
	// P2034 is Prisma's own "write conflict or deadlock", raised without a driver code.
	if (code === 'P2002' || code === 'P2034') return true;

	const driverCode = driverCodeOf(caught);
	return driverCode !== undefined && TRANSIENT_DRIVER_CODES.has(driverCode);
}

export async function withConcurrentWriteRetry<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run();
		} catch (caught) {
			if (attempt >= MAX_ATTEMPTS || !isRetryableWriteConflict(caught)) throw caught;
			// Jittered, and growing with each attempt: retrying in lockstep is what turns one
			// collision into the next one.
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * attempt));
		}
	}
}
