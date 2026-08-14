import { sanitizeImportedText } from '../utils/safety';

/**
 * The closed role set. Four, by specification, and the closure is what makes the model's explicit
 * columns a schema property rather than a validation rule (ASVS 5.0 V2.2.1).
 *
 * Order matters: it is the order the roles are reported in, and the design plate requires a
 * missing-roles sentence to name them in row order rather than as a count.
 */
export const MAPPING_ROLES = ['date', 'label', 'amount', 'category'] as const;

export type MappingRole = (typeof MAPPING_ROLES)[number];

/** The three a transaction cannot be built without. `category` is the optional fourth. */
export const REQUIRED_MAPPING_ROLES = ['date', 'label', 'amount'] as const satisfies readonly MappingRole[];

export type ColumnMatchBy = 'name' | 'position';

export interface ColumnMappingInput {
	matchBy: ColumnMatchBy;
	dateColumn: string | null;
	labelColumn: string | null;
	amountColumn: string | null;
	categoryColumn: string | null;
	dateIndex: number | null;
	labelIndex: number | null;
	amountIndex: number | null;
	categoryIndex: number | null;
	columnCount: number;
}

export type ColumnMappingRefusal =
	| { code: 'missing-required-role'; role: MappingRole }
	| { code: 'roles-share-a-column'; roles: [MappingRole, MappingRole] }
	| { code: 'category-repeats-required-role'; role: MappingRole }
	| { code: 'match-by-unknown'; value: string }
	| { code: 'name-mapping-carries-indices' }
	| { code: 'position-mapping-carries-names' }
	| { code: 'index-out-of-range'; role: MappingRole }
	| { code: 'column-count-invalid' };

export type ColumnMappingVerdict = { ok: true } | { ok: false; reason: ColumnMappingRefusal };

/**
 * The longest column name written to the database.
 *
 * `sanitizeImportedText` normalises mojibake, collapses whitespace and neutralises a leading
 * formula character, and it puts NO bound on length. That did not matter while these values stayed
 * on the server; a stored column name is different, because it is a cell from a user's file, it is
 * rendered back to them, and it lives under a `varchar(191)` on MySQL.
 *
 * `Account.name` already taught this repository the shape: an uncapped string on an indexed column
 * is a write MySQL rejects and SQLite accepts, so an unbounded name is a mapping that saves on one
 * engine and fails on another. 120 matches `MAX_BUCKET_NAME_LENGTH` for the same reason.
 */
export const MAX_COLUMN_NAME_LENGTH = 120;

/**
 * A column name on its way into the database. Sanitise AND bound, never `sanitizeImportedText`
 * alone.
 *
 * Cut on CHARACTERS rather than UTF-16 code units: slicing mid-surrogate leaves a lone half that
 * is not valid UTF-8, which MySQL's utf8mb4 rejects. Same reasoning as `capBucketName`.
 */
export function boundedColumnName(value: string): string {
	const sanitized = sanitizeImportedText(value);
	if (sanitized.length <= MAX_COLUMN_NAME_LENGTH) return sanitized;
	return Array.from(sanitized).slice(0, MAX_COLUMN_NAME_LENGTH).join('');
}

/**
 * THE ONE VALIDATOR. Called by the form path AND by `assertReferentialIntegrity` on the restore
 * path, and the fact that it is one function rather than two agreeing predicates is the point.
 *
 * This repository has shipped the two-predicate version once: `replaceSplits` enforced the sum
 * invariant while `restoreBackup` inserted parts with `createMany`, so a hand-edited backup could
 * write a repartition summing to anything. A mapping arriving through a restore is strictly more
 * dangerous than a split was, because a bad split is one wrong transaction and a bad mapping is
 * every future import of that shape.
 *
 * A selector that does not offer a choice is an affordance. This is the control (ASVS 5.0 V8.3.1).
 */
export function validateColumnMapping(input: ColumnMappingInput): ColumnMappingVerdict {
	if (input.matchBy !== 'name' && input.matchBy !== 'position') {
		return { ok: false, reason: { code: 'match-by-unknown', value: String(input.matchBy) } };
	}

	if (!Number.isInteger(input.columnCount) || input.columnCount < 1) {
		return { ok: false, reason: { code: 'column-count-invalid' } };
	}

	const names: Record<MappingRole, string | null> = {
		date: input.dateColumn,
		label: input.labelColumn,
		amount: input.amountColumn,
		category: input.categoryColumn
	};
	const indices: Record<MappingRole, number | null> = {
		date: input.dateIndex,
		label: input.labelIndex,
		amount: input.amountIndex,
		category: input.categoryIndex
	};

	// Exactly one space is populated, never both. A precedence rule between them would be a second
	// thing that can be wrong, and the fingerprint's canonical form already depends on this field.
	if (input.matchBy === 'name' && MAPPING_ROLES.some((role) => indices[role] !== null)) {
		return { ok: false, reason: { code: 'name-mapping-carries-indices' } };
	}
	if (input.matchBy === 'position' && MAPPING_ROLES.some((role) => names[role] !== null)) {
		return { ok: false, reason: { code: 'position-mapping-carries-names' } };
	}

	const slot = (role: MappingRole): string | number | null =>
		input.matchBy === 'name' ? names[role] : indices[role];

	for (const role of REQUIRED_MAPPING_ROLES) {
		if (slot(role) === null) return { ok: false, reason: { code: 'missing-required-role', role } };
	}

	if (input.matchBy === 'position') {
		for (const role of MAPPING_ROLES) {
			const index = indices[role];
			if (index === null) continue;
			if (!Number.isInteger(index) || index < 0 || index >= input.columnCount) {
				return { ok: false, reason: { code: 'index-out-of-range', role } };
			}
		}
	}

	// No two REQUIRED roles share a column. Reported as an ordered pair so the message can name
	// both rather than telling the user to look at half the problem.
	for (let i = 0; i < REQUIRED_MAPPING_ROLES.length; i += 1) {
		for (let j = i + 1; j < REQUIRED_MAPPING_ROLES.length; j += 1) {
			const left = REQUIRED_MAPPING_ROLES[i];
			const right = REQUIRED_MAPPING_ROLES[j];
			if (slot(left) !== null && slot(left) === slot(right)) {
				return { ok: false, reason: { code: 'roles-share-a-column', roles: [left, right] } };
			}
		}
	}

	// And the optional role never takes a column a required one holds. See the model docstring in
	// schema.prisma for the refused alternative and the measurement that refused it: a 148-line
	// file with 100 distinct merchants creates 100 categories, and because the mapping is
	// remembered it repeats on every later import with nobody watching.
	const category = slot('category');
	if (category !== null) {
		for (const role of REQUIRED_MAPPING_ROLES) {
			if (slot(role) === category) {
				return { ok: false, reason: { code: 'category-repeats-required-role', role } };
			}
		}
	}

	return { ok: true };
}
