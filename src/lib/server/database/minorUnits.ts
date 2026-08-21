// Relative, `.ts`-suffixed imports where this file has any: `client.ts` reaches it, and plain
// Node runs that for the maintenance scripts with no Vite resolution and no `$lib` alias.

/**
 * The one place a 64-bit money column becomes the `number` the domain uses.
 *
 * ## Why the column is 64-bit and the domain is not
 *
 * The eight money columns hold integer minor units, and every row carries the exponent that says
 * what the integer means. The same major-unit magnitude therefore needs ten or a hundred times
 * more minor units at exponent 3 or 4 than at exponent 2, and `domain/netWorth.ts`'s own cap
 * overflows a signed 32-bit column by about five times at exponent 3. So the COLUMN has to be
 * 64-bit.
 *
 * JavaScript is not the constraint and never was. A `number` holds every integer up to 2^53
 * exactly, which is about nine million times the largest amount this application allows. Widening
 * the domain to `bigint` would buy nothing and cost everything: `JSON.stringify` throws on a
 * bigint, so the backup export dies; `bigint + number` throws, so every aggregate dies; and
 * `Math.abs` throws, so `persist.ts` dies. Prisma is what forces the choice, because a `BigInt`
 * scalar reads as a `bigint` and `Int @db.BigInt` is refused on all three connectors.
 *
 * ## Why this throws instead of converting
 *
 * Past 2^53 the conversion still succeeds and is wrong by an amount nothing downstream can detect.
 * The arithmetic still balances, the display still renders, the export still parses, and only the
 * figure is false. That is the failure direction this codebase refuses everywhere else, so the
 * excess is measured here rather than clamped: a fixed size that prevents a defect also hides it.
 *
 * The message names the field and the value. A refusal that says neither sends whoever reads the
 * log back to the database to work out which column and which row.
 */
const MAX_EXACT = BigInt(Number.MAX_SAFE_INTEGER);

export function toMinorUnits(value: bigint | number, field: string): number {
	// A number arrives from SQLite, which stores these as INTEGER either way, and from a raw query,
	// which returns whatever the driver made of it. Both are already exact.
	if (typeof value === 'number') return value;

	if (value > MAX_EXACT || value < -MAX_EXACT) {
		throw new Error(
			`${field} holds ${value} minor units, past the range a number represents exactly ` +
				`(${Number.MAX_SAFE_INTEGER}). Converting it would change the amount silently.`
		);
	}

	return Number(value);
}

/** The same, for the reads that can be absent: an aggregate over no rows is null, not zero. */
export function toNullableMinorUnits(
	value: bigint | number | null,
	field: string
): number | null {
	return value === null ? null : toMinorUnits(value, field);
}
