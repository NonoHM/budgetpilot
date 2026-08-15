import { describe, expect, it } from 'vitest';
import { refusalLabel, scopeLabel, violationLabel } from './refusalLabel';
import { CSV_REFUSAL_CODES, type CsvRefusalFact } from '$lib/server/import/refusals';
import { TRANSACTION_VALIDATION_CODES } from '$lib/domain/transaction';

/**
 * The renderer is the only place a refusal becomes language, so this file is what stops a
 * code reaching a user with nothing to say.
 *
 * It runs in the `server` project, whose setup pins the locale to French with
 * `overwriteGetLocale`, for the reason recorded in `vitest.server.setup.ts`: the base locale is
 * `en`, and ten server specs assert French copy, so the pin is deliberate rather than
 * incidental. That is why the anchors below are French. It is also why an anchor exists at
 * all: every assertion here except the anchors is relational (every code renders something,
 * all renders differ), and a relational assertion passes in a world where the catalogue never
 * loaded and every call returned its own key. One absolute figure proves the environment is
 * real.
 */

/**
 * One fact per code, with a payload where the union demands one. Built as a Record keyed by
 * the code so the type checker refuses a fixture set that has drifted from the union: add a
 * code and this object fails to compile until it gets an entry.
 */
const FACTS: { [C in CsvRefusalFact['code']]: Extract<CsvRefusalFact, { code: C }> } = {
	'file-too-large': { code: 'file-too-large', bytes: 512_000 },
	'file-empty': { code: 'file-empty' },
	'too-many-rows': { code: 'too-many-rows', max: 5000 },
	'too-many-columns': { code: 'too-many-columns', max: 512 },
	'header-not-recognized': { code: 'header-not-recognized', profile: 'Revolut' },
	'unknown-column': { code: 'unknown-column', column: 'wibble' },
	'duplicate-column': { code: 'duplicate-column', column: 'date' },
	'missing-required-column': { code: 'missing-required-column', column: 'amount' },
	'bad-column-count': { code: 'bad-column-count', expected: 5, actual: 4 },
	'ambiguous-column-mapping': {
		code: 'ambiguous-column-mapping',
		role: 'date',
		columns: 'dateop, booking date'
	},
	'amount-sign-in-separate-column': { code: 'amount-sign-in-separate-column', column: 'sens' },
	'amount-split-across-columns': {
		code: 'amount-split-across-columns',
		columns: '« Debit » et « Credit »'
	},
	'mapping-columns-missing': { code: 'mapping-columns-missing', roles: 'label, amount' },
	'mapping-invalid': { code: 'mapping-invalid', reason: 'roles-share-a-column' },
	'invalid-date': { code: 'invalid-date', column: 'date' },
	'invalid-amount': { code: 'invalid-amount', column: 'montant' },
	'zero-amount': { code: 'zero-amount', column: 'montant' },
	'invalid-total-amount': { code: 'invalid-total-amount', column: 'montant_total' },
	'type-amount-mismatch': { code: 'type-amount-mismatch' },
	'invalid-nature': { code: 'invalid-nature', value: 'wibble' },
	'invalid-fee': { code: 'invalid-fee' },
	'invalid-balance': { code: 'invalid-balance' },
	'unsupported-currency': { code: 'unsupported-currency', currency: 'JPY' },
	'state-not-completed': { code: 'state-not-completed', state: 'PENDING' },
	'footer-ignored': { code: 'footer-ignored' },
	'debit-credit-both': { code: 'debit-credit-both' },
	'debit-credit-empty': { code: 'debit-credit-empty' },
	'category-too-long': { code: 'category-too-long' },
	'split-column-unreadable': { code: 'split-column-unreadable' },
	'split-out-of-bounds': { code: 'split-out-of-bounds' },
	'split-inconsistent': { code: 'split-inconsistent' },
	'split-incomplete': { code: 'split-incomplete' },
	'split-too-many-lines': { code: 'split-too-many-lines' },
	'split-duplicate-positions': { code: 'split-duplicate-positions' },
	'split-parent-category-inconsistent': { code: 'split-parent-category-inconsistent' },
	'split-reserved-category-on-part': { code: 'split-reserved-category-on-part' },
	'split-sign-opposite': { code: 'split-sign-opposite' },
	'split-sum-mismatch': { code: 'split-sum-mismatch' },
	'transaction-invalid': { code: 'transaction-invalid', violations: ['label-too-long'] }
};

describe('refusalLabel', () => {
	it('renders the catalogue rather than the key, on a value known by hand', () => {
		// The absolute anchor. If the catalogue failed to load, paraglide returns the key and
		// every relational assertion below still passes.
		expect(refusalLabel({ code: 'file-empty' })).toBe('CSV vide ou sans données');
	});

	it('renders every code in the union, and there are 39 of them', () => {
		const rendered = CSV_REFUSAL_CODES.map((code) => refusalLabel(FACTS[code]));

		// The absolute figure beside the emptiness assertion: a run that rendered nothing at all
		// would satisfy "none is empty" perfectly.
		expect(rendered).toHaveLength(39);
		expect(CSV_REFUSAL_CODES).toHaveLength(39);
		expect(rendered.filter((label) => label.trim().length > 0)).toHaveLength(39);
		// A key leaking through would render as the key itself.
		expect(rendered.filter((label) => label.startsWith('import_refusal_'))).toEqual([]);
	});

	it('gives every code its own sentence, so two refusals never read alike', () => {
		const rendered = CSV_REFUSAL_CODES.map((code) => refusalLabel(FACTS[code]));

		// Two guards in sequence are indistinguishable to a user when they render the same
		// sentence, which is the whole reason the contract names them separately.
		expect(new Set(rendered).size).toBe(39);
	});

	it('renders the payload of the three facts whose sentence names a value', () => {
		expect(refusalLabel({ code: 'unknown-column', column: 'wibble' })).toBe(
			'Colonne non autorisée: wibble'
		);
		expect(refusalLabel({ code: 'duplicate-column', column: 'date' })).toContain('date');
		expect(refusalLabel({ code: 'missing-required-column', column: 'amount' })).toContain('amount');
	});

	it('joins a domain verdict in the order the validator pushed it', () => {
		// The order is the visible half: it is what makes today's sentence identical to the
		// `errors.join(', ')` this replaces. Reversing the array must change the output.
		const forwards = refusalLabel({
			code: 'transaction-invalid',
			violations: ['label-too-long', 'category-required']
		});
		const backwards = refusalLabel({
			code: 'transaction-invalid',
			violations: ['category-required', 'label-too-long']
		});

		expect(forwards).toBe('libellé trop long, catégorie requise');
		expect(backwards).toBe('catégorie requise, libellé trop long');
		expect(forwards).not.toBe(backwards);
	});
});

describe('violationLabel', () => {
	it('renders every domain code, and there are 11 of them', () => {
		const rendered = TRANSACTION_VALIDATION_CODES.map(violationLabel);

		expect(rendered).toHaveLength(11);
		expect(rendered.filter((label) => label.trim().length > 0)).toHaveLength(11);
		expect(new Set(rendered).size).toBe(11);
		expect(rendered.filter((label) => label.startsWith('import_refusal_tx_'))).toEqual([]);
	});
});

describe('scopeLabel', () => {
	it('names the scope when there is no line, and prints the line when there is', () => {
		expect(scopeLabel({ kind: 'header' })).toBe('en-tête');
		expect(scopeLabel({ kind: 'file' })).toBe('fichier');
		expect(scopeLabel({ kind: 'row', line: 42 })).toBe('42');
	});

	it('never presents a header or file refusal as a line number', () => {
		// #291 in its rendered form: the old page printed `1`, `2`, `3` here, pointing a user at
		// transaction rows that were never examined.
		expect(scopeLabel({ kind: 'header' })).not.toMatch(/^\d+$/);
		expect(scopeLabel({ kind: 'file' })).not.toMatch(/^\d+$/);
	});
});
