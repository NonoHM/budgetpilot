import { describe, expect, it } from 'vitest';
import { mappingFromPostedIndices } from './designation';

/**
 * The header cells are FILE CONTENT, not identifiers, which is why they read like a bank's.
 */
const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];

const VALID = { date: '0', label: '2', amount: '3' };

describe('the mapping is resolved through the SERVER header list, never the client one', () => {
	it('reads the column names out of the headers the server passed in', () => {
		// The two states this separates: a mapping whose names came from the file the server just
		// read, and one whose names came from the browser. They look identical in the database and
		// only the first is evidence. The client posts indices and nothing else, so there is no
		// second source for these strings to come from.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { ...VALID, category: '4' },
			hasHeaderRow: true
		});

		expect(result).toStrictEqual({
			ok: true,
			mapping: {
				matchBy: 'name',
				dateColumn: 'Date operation',
				labelColumn: 'Libelle',
				amountColumn: 'Montant',
				categoryColumn: 'Categorie',
				dateIndex: null,
				labelIndex: null,
				amountIndex: null,
				categoryIndex: null,
				columnCount: 5
			}
		});
	});

	it('refuses an index past the end of the SERVER list, however valid it was client side', () => {
		// ASVS V8.3.1, and the case the control exists for: a choice the screen could legitimately
		// have offered against a different file. Stored unchecked, the amount role would address
		// nothing today and would silently read money out of whatever lands at index 9 tomorrow.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { ...VALID, amount: '9' },
			hasHeaderRow: true
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: { code: 'index-out-of-range', role: 'amount', index: 9, columnCount: 5 }
		});
	});

	it('accepts the LAST valid index, so the refusal does not eat a real column', () => {
		// One of the two boundary tests. Without it, tightening the comparison would make the last
		// column of every file undesignable and no test would notice.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { date: '0', label: '2', amount: '4' },
			hasHeaderRow: true
		});

		expect(result.ok).toBe(true);
		expect(result.ok && result.mapping.amountColumn).toBe('Categorie');
	});

	it('refuses the index one PAST the last, which is exactly columnCount', () => {
		// The other boundary test, and it was missing on the first pass. Measured 2026-08-15:
		// loosening `>=` to `>` left all eleven tests green, because the refusal case used index 9
		// (still refused either way) and the acceptance case used index 4 (still accepted either
		// way). Neither could see the one value the comparison actually decides.
		//
		// It is the difference between an index that addresses a column and one that addresses
		// nothing, on the field that decides which column is money.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { ...VALID, amount: String(HEADERS.length) },
			hasHeaderRow: true
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: { code: 'index-out-of-range', role: 'amount', index: 5, columnCount: 5 }
		});
	});
});

describe('an index is positively validated, not merely checked for being obviously wrong', () => {
	it('refuses values the loose parsers would have accepted', () => {
		// `Number.parseInt` accepts the first two and `Number` accepts the rest. Each is a value no
		// honest client sends, so accepting any of them means accepting something only a crafted
		// request produces. Named individually rather than looped, so a failure says which one.
		for (const value of ['3abc', '0x1', '3.0', ' 3', '1e1', '-1', '+3', 'Infinity']) {
			const result = mappingFromPostedIndices({
				headers: HEADERS,
				posted: { ...VALID, amount: value },
				hasHeaderRow: true
			});

			expect(result, value).toStrictEqual({
				ok: false,
				reason: { code: 'index-not-an-integer', role: 'amount', value }
			});
		}
	});

	it('accepts a plain decimal index, so the refusals above are about the FORM of the value', () => {
		// The presence half. Without it every assertion above is satisfied by a function that
		// refuses everything, which is the shape this repository has shipped once already.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: VALID,
			hasHeaderRow: true
		});

		expect(result.ok).toBe(true);
	});
});

describe('the closed role set is a property of the loop, not a check', () => {
	it('never reads a posted key the application does not know', () => {
		// V2.2.1. A free-text role arriving from a client or a restored backup has nowhere to land:
		// the loop iterates MAPPING_ROLES, so the extra key is not rejected, it is never looked at.
		// Asserted by the OUTPUT being identical with and without it, which is what "never read"
		// means; a test that asserted a refusal would be describing a different design.
		const withExtra = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { ...VALID, currency: '1', __proto__: '2' } as never,
			hasHeaderRow: true
		});
		const without = mappingFromPostedIndices({
			headers: HEADERS,
			posted: VALID,
			hasHeaderRow: true
		});

		expect(withExtra).toStrictEqual(without);
		expect(withExtra.ok).toBe(true);
	});
});

describe('the three required roles must all be present', () => {
	it('names the missing role rather than reporting that something was missing', () => {
		// A refusal asserts the REASON. Two guards in sequence are indistinguishable from one when
		// the assertion only says it was refused, and the user has to be sent to the right row.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { date: '0', amount: '3' },
			hasHeaderRow: true
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: { code: 'required-role-absent', role: 'label' }
		});
	});

	it('treats an empty string as absent rather than as index zero', () => {
		// The two states this separates: a role the user left empty, and a role the user pointed at
		// the first column. An empty form field coerced through a numeric parser becomes 0 in both
		// JavaScript and in several form libraries, which would silently designate column one.
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: { date: '0', label: '', amount: '3' },
			hasHeaderRow: true
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: { code: 'required-role-absent', role: 'label' }
		});
	});

	it('lets the optional role be absent, which is the whole of its optionality', () => {
		const result = mappingFromPostedIndices({
			headers: HEADERS,
			posted: VALID,
			hasHeaderRow: true
		});

		expect(result.ok).toBe(true);
		expect(result.ok && result.mapping.categoryColumn).toBeNull();
	});
});

describe('a headerless file is keyed by position, and carries no names at all', () => {
	it('stores indices and leaves every column name null', () => {
		// The two modes must not both carry both, and the reason is the collision this chantier
		// already measured: a canonical form shared by two modes lets a reordered file find a
		// positional mapping whose indices point at different columns.
		const result = mappingFromPostedIndices({
			headers: ['', '', '', '', ''],
			posted: { ...VALID, category: '4' },
			hasHeaderRow: false
		});

		expect(result).toStrictEqual({
			ok: true,
			mapping: {
				matchBy: 'position',
				dateColumn: null,
				labelColumn: null,
				amountColumn: null,
				categoryColumn: null,
				dateIndex: 0,
				labelIndex: 2,
				amountIndex: 3,
				categoryIndex: 4,
				columnCount: 5
			}
		});
	});
});

describe('a file with no columns at all', () => {
	it('refuses before any index can be judged in range', () => {
		// Order matters: with zero columns every index is out of range, so a refusal naming a role
		// would blame the user's choice for a property of the file.
		const result = mappingFromPostedIndices({ headers: [], posted: VALID, hasHeaderRow: true });

		expect(result).toStrictEqual({ ok: false, reason: { code: 'no-columns' } });
	});
});
