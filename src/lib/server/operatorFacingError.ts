/**
 * An error whose message was written for whoever runs the instance and carries no stored data:
 * the boot report naming a missing variable, a lock timeout, a stalled backfill counted in rows.
 *
 * It is the one error whose MESSAGE `loggableError` (server/errors.ts) lets into the log, so
 * interpolating a stored value into one is the defect to look for in review (#816).
 *
 * Its own module with no imports, because the backfills that throw it are also loaded by plain-Node
 * scripts (`scripts/normalize-names.mjs`), where neither `$lib` nor `@sveltejs/kit` resolves.
 */
export class OperatorFacingError extends Error {
	override name = 'OperatorFacingError';
}
