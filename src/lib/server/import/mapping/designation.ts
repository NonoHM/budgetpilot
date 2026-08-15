import {
	MAPPING_ROLES,
	REQUIRED_MAPPING_ROLES,
	type ColumnMappingInput,
	type MappingRole
} from './model';

/**
 * Turns what the BROWSER posted into a mapping, against the headers the SERVER re-derived.
 *
 * ## This is the control. The screen is only the affordance
 *
 * ASVS 5.0 **V8.3.1**: an authorization or integrity decision is taken on the server, from state
 * the server established, never from state the client supplied. The designation screen is a
 * convenience that helps a user pick sensible indices; nothing it renders is evidence.
 *
 * So the client posts INDICES and nothing else. It does not post column names, because a posted
 * name would be a string the server then has to trust or re-derive anyway, and it does not post a
 * header count, because that is exactly the number an attacker would want to move. The caller
 * re-reads the uploaded file and passes ITS OWN `headers`; every index is checked against that
 * array and resolved through it.
 *
 * **What that closes.** Posting `amountIndex: 9` on a four-column file would otherwise store a
 * mapping whose amount role addresses nothing, and the failure would not surface here: it would
 * surface later as a file that imports with every amount missing, or, worse, after a bank adds a
 * column, as a mapping that silently reads money out of whatever now sits at index 9.
 *
 * ## V2.2.1, positive validation against an allow list
 *
 * The strongest row that applies to this chantier, and it is satisfied structurally rather than by
 * a check: **the role set is closed at four and is iterated from `MAPPING_ROLES`**, so a posted key
 * the application does not know is not rejected, it is never read. A free-text role arriving from a
 * client or from a restored backup has nowhere to land.
 *
 * Each index is validated positively too: an integer, within range, rather than "not obviously
 * wrong". `Number.parseInt` is deliberately not used, because it accepts `'3abc'` and `'0x10'` and
 * would let a value through that no honest client sends.
 *
 * ## What this does NOT do
 *
 * It does not bound or sanitise the column names it resolves, and it must not: `saveColumnMapping`
 * does that for every write path at once, and doing it twice in two places is how the two versions
 * come to disagree. It does not enforce owner ruling 1 either; `validateColumnMapping` does, and it
 * is the single validator both write paths share.
 */
export type DesignationRefusal =
	| { code: 'no-columns' }
	| { code: 'index-not-an-integer'; role: MappingRole; value: string }
	| { code: 'index-out-of-range'; role: MappingRole; index: number; columnCount: number }
	| { code: 'required-role-absent'; role: MappingRole };

export type DesignationResult =
	{ ok: true; mapping: ColumnMappingInput } | { ok: false; reason: DesignationRefusal };

/** What the form posts, per role: a decimal index as a string, or nothing at all. */
export type PostedIndices = Partial<Record<MappingRole, string | null>>;

/**
 * A decimal, non-negative, safe integer, and nothing else.
 *
 * `Number.parseInt` accepts `'3abc'`, `'0x10'` and `' 3'`, and `Number()` accepts `'3.0'`, `''`
 * and `'1e2'`. Both would let through a value no honest client sends, and the whole point of this
 * function is that only what an honest client sends is accepted.
 */
function parseIndex(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

export function mappingFromPostedIndices(input: {
	/** The header cells the SERVER read from the re-posted file. Never the client's copy. */
	headers: readonly string[];
	posted: PostedIndices;
	/**
	 * False when the first line is data. The mapping is then keyed by POSITION, because there is no
	 * stable text to match on, and `fingerprintFor` is order sensitive in that mode for exactly this
	 * reason: a reordered export must not find a mapping whose indices point somewhere else.
	 */
	hasHeaderRow: boolean;
}): DesignationResult {
	const columnCount = input.headers.length;
	if (columnCount === 0) return { ok: false, reason: { code: 'no-columns' } };

	const resolved: Partial<Record<MappingRole, number>> = {};

	// Iterated from the CLOSED role set, so a posted key the application does not know is never
	// read rather than being rejected. V2.2.1 as a property of the loop.
	for (const role of MAPPING_ROLES) {
		const raw = input.posted[role];
		if (raw === undefined || raw === null || raw === '') continue;

		const index = parseIndex(raw);
		if (index === null) {
			return { ok: false, reason: { code: 'index-not-an-integer', role, value: raw } };
		}
		if (index >= columnCount) {
			return { ok: false, reason: { code: 'index-out-of-range', role, index, columnCount } };
		}
		resolved[role] = index;
	}

	for (const role of REQUIRED_MAPPING_ROLES) {
		if (resolved[role] === undefined) {
			return { ok: false, reason: { code: 'required-role-absent', role } };
		}
	}

	const at = (role: MappingRole) => resolved[role] ?? null;
	const nameAt = (role: MappingRole) => {
		const index = resolved[role];
		return index === undefined ? null : (input.headers[index] ?? null);
	};

	if (!input.hasHeaderRow) {
		return {
			ok: true,
			mapping: {
				matchBy: 'position',
				dateColumn: null,
				labelColumn: null,
				amountColumn: null,
				categoryColumn: null,
				dateIndex: at('date'),
				labelIndex: at('label'),
				amountIndex: at('amount'),
				categoryIndex: at('category'),
				columnCount
			}
		};
	}

	return {
		ok: true,
		mapping: {
			matchBy: 'name',
			dateColumn: nameAt('date'),
			labelColumn: nameAt('label'),
			amountColumn: nameAt('amount'),
			categoryColumn: nameAt('category'),
			dateIndex: null,
			labelIndex: null,
			amountIndex: null,
			categoryIndex: null,
			columnCount
		}
	};
}
