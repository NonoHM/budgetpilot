import { describe, expect, it } from 'vitest';
import { refusalLabel, scopeLabel, violationLabel } from './refusalLabel';
import { roleLabel } from '$lib/domain/columnMappingLabels';
import {
	CSV_REFUSAL_CODES,
	type CsvRefusalCode,
	type CsvRefusalFact
} from '$lib/server/import/refusals';
import { TRANSACTION_VALIDATION_CODES } from '$lib/domain/transaction';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';

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

type FactOf<C extends CsvRefusalCode> = Extract<CsvRefusalFact, { code: C }>;
type FieldOf<C extends CsvRefusalCode> = Exclude<keyof FactOf<C>, 'code'>;

/**
 * Where a value a refusal CARRIES reaches the reader (#692).
 *
 * - `'sentence'`: the rendered sentence itself shows it.
 * - `{ by }`: the sentence does not, and another element on the screen that shows this refusal
 *   does. Named precisely enough to go and look at.
 * - `{ withheld }`: nothing on the screen shows it, and why that is the answer rather than a gap.
 */
type Shown = 'sentence' | { by: string } | { withheld: string };

/**
 * EVERY CODE, AND EVERY FIELD OF EVERY CODE, CLASSIFIED ONCE. The one list of codes in this file.
 *
 * Typed per code AND per field, the pattern `DESIGNATION_REACH` uses one level down: a code added
 * to `CsvRefusalFact` fails to compile here until it has an entry, and so does a field added to an
 * existing code. Each field carries two values of its own type; `FACTS` below is built from the
 * first, and the classification test swaps in the second.
 *
 * The question each `Shown` answers is AGENTS.md's « ask what the server KNOWS that the reader
 * cannot see »: a value the server holds and no element shows is a sentence withholding it.
 */
const FIELD_DISPLAY: {
	[C in CsvRefusalCode]: {
		[F in FieldOf<C>]: { shown: Shown; values: readonly [FactOf<C>[F], FactOf<C>[F]] };
	};
} = {
	'file-too-large': { bytes: { shown: 'sentence', values: [512_000, 256_001] } },
	'file-empty': {},
	'too-many-rows': { max: { shown: 'sentence', values: [5000, 4000] } },
	'too-many-columns': { max: { shown: 'sentence', values: [512, 256] } },
	'header-not-recognized': { profile: { shown: 'sentence', values: ['Revolut', 'N26'] } },
	'declared-currency-mismatch': {
		declared: { shown: 'sentence', values: ['EUR', 'GBP'] },
		destination: { shown: 'sentence', values: ['USD', 'CHF'] }
	},
	'unknown-column': { column: { shown: 'sentence', values: ['wibble', 'wobble'] } },
	'duplicate-column': { column: { shown: 'sentence', values: ['date', 'libelle'] } },
	'missing-required-column': { role: { shown: 'sentence', values: ['amount', 'label'] } },
	'bad-column-count': {
		expected: { shown: 'sentence', values: [5, 7] },
		actual: { shown: 'sentence', values: [4, 6] }
	},
	'ambiguous-column-mapping': {
		role: { shown: 'sentence', values: ['date', 'amount'] },
		columns: { shown: 'sentence', values: ['dateop, booking date', 'montant, amount'] }
	},
	'amount-sign-in-separate-column': {
		column: { shown: 'sentence', values: ['sens', 'direction'] }
	},
	'amount-split-across-columns': {
		columns: { shown: 'sentence', values: ['« Debit » et « Credit »', '« Sortie » et « Entrée »'] }
	},
	'mapping-columns-missing': {
		roles: { shown: 'sentence', values: [['label', 'amount'], ['date']] }
	},
	'mapping-invalid': {
		reason: {
			shown: {
				withheld:
					'a validator code the reader cannot act on; the sentence says what they can do (refusals.ts)'
			},
			values: ['roles-share-a-column', 'mapping-absent']
		}
	},
	'invalid-date': {
		column: {
			shown: { by: "the rows table's field cell: every producer sets `field` to this column" },
			values: ['date', 'Date de fin']
		},
		value: { shown: 'sentence', values: ['01.06.2026', '31.02.2026'] }
	},
	// The three amount codes: the field cell shows `CsvRefusal.field`, which is the internal key
	// (« amount ») on the house format and on generic files rather than the header. That spelling
	// is #761's, not this table's.
	'invalid-amount': {
		column: {
			shown: { by: "the rows table's field cell (`CsvRefusal.field`)" },
			values: ['montant', 'Montant']
		}
	},
	'zero-amount': {
		column: {
			shown: { by: "the rows table's field cell (`CsvRefusal.field`)" },
			values: ['montant', 'Debit']
		}
	},
	'invalid-total-amount': {
		column: {
			shown: { by: "the rows table's field cell (`CsvRefusal.field`)" },
			values: ['montant_total', 'total']
		}
	},
	'type-amount-mismatch': {},
	'invalid-nature': {
		value: {
			// `nature` is the house format's sixth column, inside the preview's first eight cells.
			shown: { by: "the rows table's row preview (`invalidRowDetails.ts`)" },
			values: ['wibble', 'wobble']
		}
	},
	'invalid-fee': {},
	'invalid-balance': {},
	// #692: the value is the ONLY place the refused currency reaches the reader. A currency
	// declared by the amount header (`resolvedRows.ts`) is in no row, so no preview can show it.
	'unsupported-currency': { currency: { shown: 'sentence', values: ['JPY', 'GBP'] } },
	// #692: Revolut's ninth column, past the preview's eight cells on a full row.
	'state-not-completed': { state: { shown: 'sentence', values: ['PENDING', 'REVERTED'] } },
	'footer-ignored': {},
	'debit-credit-both': {},
	'debit-credit-empty': {},
	'category-too-long': {},
	'control-character': {},
	'split-column-unreadable': {},
	'split-out-of-bounds': {},
	'split-inconsistent': {},
	'split-incomplete': {},
	'split-too-many-lines': {},
	'split-duplicate-positions': {},
	'split-parent-category-inconsistent': {},
	'split-reserved-category-on-part': {},
	'split-sign-opposite': {},
	'split-sum-mismatch': {},
	'transaction-invalid': {
		violations: { shown: 'sentence', values: [['label-too-long'], ['category-required']] }
	},
	'mixed-date-order': {
		dayFirst: { shown: 'sentence', values: ['24/06/2026', '25/06/2026'] },
		monthFirst: { shown: 'sentence', values: ['06/24/2026', '06/25/2026'] }
	},
	// The route answers both date-order and account-column facts with a control, and the control
	// is what shows the evidence. The sentences render only when no control was built.
	'ambiguous-date-order': {
		column: {
			shown: { by: 'the reading offer, opened on this column (`reading.dateColumn`)' },
			values: [0, 2]
		},
		sample: {
			shown: { by: "the reading offer's cards, which show this column's samples" },
			values: ['06/01/2026', '07/02/2026']
		}
	},
	'multi-account-file': {
		column: {
			shown: {
				withheld:
					'an index, not a header, and no element names it on either door; left open on #761'
			},
			values: [3, 4]
		}
	},
	'ambiguous-account-column': {
		column: {
			shown: {
				by: '`AccountColumnDialog` names the header on /import; `import_error_account_column_unanswerable` on /import/columns'
			},
			values: [3, 4]
		},
		sample: {
			shown: { by: "`AccountColumnDialog`'s evidence line, the column's own samples" },
			values: ['10000001', '10000002']
		}
	}
};

/**
 * A fact built from the table, with `values[which]` in every field, or `values[1]` in the one
 * field `swap` names. The one cast in this file: the table's type is what guarantees every field
 * of the code is present, and `Object.entries` cannot carry that through.
 */
function factFrom<C extends CsvRefusalCode>(code: C, swap?: string): FactOf<C> {
	const fields = Object.entries(FIELD_DISPLAY[code]) as Array<[string, { values: unknown[] }]>;
	return Object.fromEntries([
		['code', code],
		...fields.map(([name, entry]) => [name, entry.values[name === swap ? 1 : 0]])
	]) as FactOf<C>;
}

/** One fact per code, from the table above rather than from a second list. */
const FACTS = Object.fromEntries(CSV_REFUSAL_CODES.map((code) => [code, factFrom(code)])) as {
	[C in CsvRefusalCode]: FactOf<C>;
};

/** Renders in one catalogue, then puts back whatever locale the setup pinned. */
function inLocale<T>(locale: 'en' | 'fr', render: () => T): T {
	const pinned = getLocale();
	overwriteGetLocale(() => locale);
	try {
		return render();
	} finally {
		overwriteGetLocale(() => pinned);
	}
}

describe('refusalLabel', () => {
	it('renders the catalogue rather than the key, on a value known by hand', () => {
		// The absolute anchor. If the catalogue failed to load, paraglide returns the key and
		// every relational assertion below still passes.
		expect(refusalLabel({ code: 'file-empty' })).toBe('CSV vide ou sans données');
	});

	it('renders every code in the union, and there are 45 of them', () => {
		const rendered = CSV_REFUSAL_CODES.map((code) => refusalLabel(FACTS[code]));

		// The absolute figure beside the emptiness assertion: a run that rendered nothing at all
		// would satisfy "none is empty" perfectly. 44 since #485 added 'multi-account-file' and
		// 'ambiguous-account-column'; 45 since #600 added 'declared-currency-mismatch'.
		expect(rendered).toHaveLength(45);
		expect(CSV_REFUSAL_CODES).toHaveLength(45);
		expect(rendered.filter((label) => label.trim().length > 0)).toHaveLength(45);
		// A key leaking through would render as the key itself.
		expect(rendered.filter((label) => label.startsWith('import_refusal_'))).toEqual([]);
	});

	it('gives every code its own sentence, so two refusals never read alike', () => {
		const rendered = CSV_REFUSAL_CODES.map((code) => refusalLabel(FACTS[code]));

		// Two guards in sequence are indistinguishable to a user when they render the same
		// sentence, which is the whole reason the contract names them separately.
		expect(new Set(rendered).size).toBe(45);
	});

	it('renders the payload of the five facts whose sentence names a value', () => {
		expect(refusalLabel({ code: 'unknown-column', column: 'wibble' })).toBe(
			'Colonne non autorisée : wibble'
		);
		expect(refusalLabel({ code: 'duplicate-column', column: 'date' })).toContain('date');
		// The ROLE, translated, never the code. `amount` is ours and « Montant » is the word the
		// designation screen has always shown for the same thing, so this asserts the two agree
		// rather than asserting a second spelling of one of them.
		expect(refusalLabel({ code: 'missing-required-column', role: 'amount' })).toBe(
			`Colonne requise absente : ${roleLabel('amount')}`
		);
		expect(refusalLabel({ code: 'missing-required-column', role: 'amount' })).not.toContain(
			'amount'
		);
		// The fourth, and the reason this assertion is not merely symmetrical: a break that made
		// the catalogue stop interpolating `{value}` left the whole of `dateRefusal.spec.ts`
		// green, because that file asserts the FACT and this one is the only thing that reads the
		// SENTENCE. The expected form and the rejected value have to be in it together — naming
		// what the app wants without echoing what it read is the wall the user already met.
		const date = refusalLabel({ code: 'invalid-date', column: 'date', value: '01.06.2026' });
		expect(date).toContain('01.06.2026');
		expect(date).toContain('JJ/MM/AAAA');
		expect(date).toContain('AAAA-MM-JJ');

		// The fifth, and it is the first to carry TWO payload values, which is why it is asserted
		// rather than assumed to follow from the four above. A message naming one placeholder
		// correctly and misspelling the other renders half a sentence and half a literal
		// `{monthFirst}`, and every assertion this file already makes about the code would pass:
		// it is non-empty, it is not the key, and it is distinct from the other thirty-nine.
		// Both cells have to be in it, because neither is wrong on its own and the pair is the
		// finding.
		const mixed = refusalLabel({
			code: 'mixed-date-order',
			dayFirst: '24/06/2026',
			monthFirst: '06/24/2026'
		});
		expect(mixed).toContain('24/06/2026');
		expect(mixed).toContain('06/24/2026');
		expect(mixed).not.toContain('{');
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

/**
 * #692: a refusal says what it knows. The family was measured on the issue: 12 of 44 codes carried
 * a value their sentence did not show. `FIELD_DISPLAY` answers each one, and these tests hold the
 * catalogue to the answer.
 *
 * Breaks, each separating two states:
 * - `{currency}` dropped from `import_refusal_unsupported_currency` in either catalogue: the swap
 *   test reddens on `unsupported-currency.currency` (sentence shows it / does not).
 * - « Revolut » back in the currency sentence: the equality tests redden (neutral / bank-named).
 * - a code added to the union without an entry: `FIELD_DISPLAY` does not compile (`npm run check`).
 */
describe('what a refusal carries, and where the reader sees it (#692)', () => {
	const LOCALES = ['fr', 'en'] as const;

	/** Every (locale, code, field) the table classifies, with the sentence before and after a swap. */
	const swaps = LOCALES.flatMap((locale) =>
		CSV_REFUSAL_CODES.flatMap((code) =>
			Object.entries(FIELD_DISPLAY[code] as Record<string, { shown: Shown }>).map(
				([field, { shown }]) => ({
					locale,
					code,
					field,
					shown,
					before: inLocale(locale, () => refusalLabel(factFrom(code))),
					after: inLocale(locale, () => refusalLabel(factFrom(code, field)))
				})
			)
		)
	);

	it('classifies every code of the union and no other', () => {
		expect(Object.keys(FIELD_DISPLAY).sort()).toEqual([...CSV_REFUSAL_CODES].sort());
	});

	it('changes the sentence for exactly the fields it says the sentence shows, in both catalogues', () => {
		const disagreements = swaps
			.filter(({ shown, before, after }) => (shown === 'sentence') !== (before !== after))
			.map(
				({ locale, code, field, shown }) =>
					`${locale} ${code}.${field}: table says ${JSON.stringify(shown)}`
			);

		expect(disagreements).toEqual([]);
	});

	/**
	 * The absolute figure beside the empty list above: a swap loop that read no field would agree
	 * with every classification. 33 fields over 45 codes, per catalogue.
	 */
	it('read every carried field, in both catalogues', () => {
		const kinds = swaps.map(({ shown }) =>
			shown === 'sentence' ? 'sentence' : 'by' in shown ? 'by' : 'withheld'
		);

		expect({
			sentence: kinds.filter((kind) => kind === 'sentence').length,
			by: kinds.filter((kind) => kind === 'by').length,
			withheld: kinds.filter((kind) => kind === 'withheld').length
		}).toEqual({ sentence: 44, by: 18, withheld: 4 });
	});

	it('names the currency and no bank, since three producers share the sentence', () => {
		const fact = { code: 'unsupported-currency', currency: 'GBP' } as const;

		expect(inLocale('fr', () => refusalLabel(fact))).toBe('devise non prise en charge : « GBP »');
		expect(inLocale('en', () => refusalLabel(fact))).toBe('unsupported currency: “GBP”');
	});

	it('names the Revolut state, since Revolut is its one producer', () => {
		const fact = { code: 'state-not-completed', state: 'PENDING' } as const;

		expect(inLocale('fr', () => refusalLabel(fact))).toBe('état Revolut non terminé : « PENDING »');
		expect(inLocale('en', () => refusalLabel(fact))).toBe('Revolut state not completed: “PENDING”');
	});

	/**
	 * A blank cell is a value the reader cannot be shown: quoting it renders « «  » ». The sentence
	 * without the value is the answer, chosen by one function for both codes. Whitespace alone is
	 * blank too, since a quoted run of spaces reads exactly as an empty pair.
	 */
	it.each(['', '   '])('drops the quotes rather than quote a blank cell (%j)', (blank) => {
		const currency = { code: 'unsupported-currency', currency: blank } as const;
		const state = { code: 'state-not-completed', state: blank } as const;

		expect(inLocale('fr', () => refusalLabel(currency))).toBe('devise non prise en charge');
		expect(inLocale('en', () => refusalLabel(currency))).toBe('unsupported currency');
		expect(inLocale('fr', () => refusalLabel(state))).toBe('état Revolut non terminé');
		expect(inLocale('en', () => refusalLabel(state))).toBe('Revolut state not completed');
	});

	it('gives the column count it read and the one the header declares', () => {
		const fact = { code: 'bad-column-count', expected: 10, actual: 9 } as const;

		expect(inLocale('fr', () => refusalLabel(fact))).toBe(
			'nombre de colonnes incorrect : 9 au lieu de 10'
		);
		expect(inLocale('en', () => refusalLabel(fact))).toBe(
			'incorrect column count: 9 instead of 10'
		);
	});
});
