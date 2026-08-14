import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseCsvTransactions } from './csv';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { REVOLUT_HEADERS } from './profiles/revolut';
import { buildDeduplicationGroupKey } from './utils/safety';

/**
 * Property-based coverage of the CSV import parser, which is the larger of the two attacker-facing
 * parsers in this application: the file is uploaded, the content is arbitrary, and five different
 * profile parsers read it.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS PHRASED AS A PROPERTY. Example tests pin the inputs somebody
 * thought of. The defect this file was written after (#275, a `RangeError` escaping the
 * banque-populaire profile on `2026-13-45`) was not reachable from any input anybody had thought
 * of, and it survived a suite of 3000 tests. The property is the thing that was always true and
 * never written down: **a parser handed hostile bytes REFUSES them; it does not raise.**
 *
 * THE BUCKETS ARE THE POINT. A refusal is a result carrying `invalidRows` or a nonzero
 * `summary.duplicateRows`, and it is a success of the parser. A throw is a defect. Collapsing the
 * two, which is what a bare `expect(() => ...).not
 * .toThrow()` over one fixture does, is what let #275 live: every profile refused bad dates
 * loudly, four of them by returning and one by raising, and no assertion anywhere could tell those
 * apart.
 *
 * CALIBRATION IS KEYED ON THE GENERATOR, NOT ON `summary.profile`, and that is not a detail. The
 * maison-v2 parser labels its own result `profile: 'maison'`, so a coverage gate reading the
 * result reported this suite blind for maison-v2 while maison-v2 was being exercised thousands of
 * times. The gate was reading a real field of a real result and answering a question nobody had
 * asked. Every generated document now carries the label of the generator that produced it.
 *
 * RUN COUNT is deliberately modest (the whole file is well under a second) because this runs on
 * every push. The exploratory runs that found #275 were 30000 documents and live outside the
 * repository; this is the regression net, not the search.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** A plain number is not a formula. Revolut metadata carries cents as strings, so "-1234" trips a
 *  naive leading-character test: the exploratory harness reported 1492 of those as injection
 *  findings before this line existed, every one of them the harness talking to itself. */
const PLAIN_NUMBER = /^-?\d+$/;

interface Outcome {
	threw: string | null;
	refused: boolean;
	accepted: boolean;
	/** How many groups of two or more accepted rows share date, folded label, magnitude and direction. */
	collisionGroups: number;
	violations: string[];
	/** Every refusal code this parse produced, so a run can prove it REACHED a guard rather
	 *  than merely counting how many inputs were refused. */
	codes: string[];
}

/**
 * The invariant checker, extracted so the tests below can point it at a KNOWN violation and
 * require it to report. An absence assertion whose detector has never been seen to detect is
 * satisfied by a detector that looks at nothing.
 */
function inspect(content: string, parse = parseCsvTransactions): Outcome {
	let result;
	try {
		result = parse(content);
	} catch (error) {
		return {
			threw: String(error),
			refused: false,
			accepted: false,
			violations: [],
			codes: [],
			collisionGroups: 0
		};
	}

	const violations: string[] = [];
	for (const transaction of result.transactions) {
		if (!Number.isInteger(transaction.amountCents)) {
			violations.push(`amountCents is not an integer: ${transaction.amountCents}`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) {
			violations.push(`accepted date is not ISO: ${transaction.date}`);
		}
		const texts: Array<[string, string]> = [
			['label', transaction.label],
			['category', transaction.category ?? ''],
			...Object.entries(transaction.metadata ?? {}).map(
				([key, value]) => [`metadata.${key}`, String(value)] as [string, string]
			)
		];
		for (const [where, value] of texts) {
			if (PLAIN_NUMBER.test(value)) continue;
			if (FORMULA_LEAD.test(value)) violations.push(`formula character survives in ${where}`);
		}
	}

	// `summary.duplicateRows` is deliberately still read rather than deleted.
	//
	// The history is the reason this line was ever written: the refusal contract removed the
	// per-line `errors.push('Ligne N: doublon détecté')` calls one-for-one while keeping the
	// counter, so `errors.length` equalled `invalidRows.length + duplicateRows` exactly, and
	// dropping the second term would have silently reclassified every duplicate-bearing input
	// from refused to accepted.
	//
	// Since the occurrence ordinal, no profile increments it: within one file a repeated row is
	// occurrence 1 rather than a duplicate, so the term is structurally 0 at all five profiles.
	// It stays because it costs nothing and the field is still part of the summary the route
	// reads. If the field is ever removed, this term goes in the same change. What must not
	// happen is this line being simplified away while the field still exists and something
	// starts setting it again.
	const refusedSignals = result.invalidRows.length > 0 || result.summary.duplicateRows > 0;

	// Counted over the ACCEPTED rows, which is what makes it a fact about the generator rather
	// than about the parser's verdict.
	const groups = new Map<string, number>();
	for (const transaction of result.transactions) {
		const key = buildDeduplicationGroupKey({
			date: transaction.date,
			label: transaction.label,
			amountCents: transaction.amountCents,
			type: transaction.metadata.type
		});
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}

	return {
		collisionGroups: [...groups.values()].filter((count) => count > 1).length,
		threw: null,
		refused: refusedSignals || result.transactions.length === 0,
		accepted: !refusedSignals && result.transactions.length > 0,
		violations,
		codes: result.invalidRows.map((refusal) => refusal.fact.code)
	};
}

/** A parse result carrying a label a correct sanitiser could never produce. Used to point the
 *  checker at the violation it exists to report. */
function leakingResult(label: string): ReturnType<typeof parseCsvTransactions> {
	const empty = parseCsvTransactions('date;label;amount\n2026-01-02;Carrefour;12,34');
	return {
		...empty,
		transactions: [{ ...empty.transactions[0], label }]
	};
}

// --- generators, one per profile, because a header no profile recognises reaches no parser ------

const hostile = fc.string({
	unit: fc.constantFrom(
		'=',
		'+',
		'-',
		'@',
		'\t',
		'\r',
		'"',
		';',
		',',
		'\n',
		' ',
		' ',
		'é',
		'Ã©',
		'0',
		'9',
		'/',
		'.',
		"'"
	),
	maxLength: 12
});
const dateish = fc.oneof(
	{ arbitrary: fc.constantFrom('2026-01-02', '02/01/2026', '2026-03-15', '2026-12-31'), weight: 8 },
	{
		arbitrary: fc.constantFrom(
			'2026-13-45',
			'2026-02-30',
			'0000-00-00',
			'',
			'2026-01-02T10:00:00Z'
		),
		weight: 2
	},
	{ arbitrary: hostile, weight: 1 }
);
const amountish = fc.oneof(
	{ arbitrary: fc.constantFrom('-12,34', '12.34', '1 234,56', '45,00', '-7,50'), weight: 8 },
	{
		arbitrary: fc.constantFrom(
			'0',
			'-0',
			'1e309',
			'NaN',
			'Infinity',
			'9'.repeat(30),
			'',
			'--5',
			'+5'
		),
		weight: 2
	},
	{ arbitrary: hostile, weight: 1 }
);
const textish = fc.oneof(
	{ arbitrary: fc.constantFrom('Carrefour', 'Loyer', 'Salaire', 'Alimentation'), weight: 6 },
	{ arbitrary: fc.string({ maxLength: 20 }), weight: 2 },
	{ arbitrary: hostile, weight: 2 }
);
const typeish = fc.oneof(
	{ arbitrary: fc.constantFrom('expense', 'income'), weight: 8 },
	{ arbitrary: fc.constantFrom('debit', 'credit', '', 'EXPENSE'), weight: 2 }
);
const natureish = fc.oneof(
	{ arbitrary: fc.constantFrom('spending', 'income', 'transfer', 'saving'), weight: 8 },
	{ arbitrary: fc.constantFrom('', 'unknown'), weight: 2 }
);

function escapeCell(value: string): string {
	return /[;\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function documentFor(header: string, cells: fc.Arbitrary<string>[]): fc.Arbitrary<string> {
	const dataRow = fc.tuple(...cells).map((values) => values.map(escapeCell).join(';'));
	return fc
		.array(dataRow, { minLength: 1, maxLength: 5 })
		.map((rows) => [header, ...rows].join('\n'));
}

const genericDoc = documentFor('date;label;amount;category', [
	dateish,
	textish,
	amountish,
	textish
]);

/**
 * The alias resolver's own population, and it exists because measuring found the gate blind.
 *
 * Pinning the seed across the alias change gave IDENTICAL per profile counts on both sides,
 * generic included. That reads as "nothing was reclassified" and it is not what it meant: the
 * generic generator emits only the canonical `date;label;amount;category`, so it never produced
 * an alias spelling, an unrecognised column or a collision, and the gate could not observe the
 * change at all. A population that excludes the change cannot report on it.
 *
 * These four shapes are what the resolver actually meets:
 *  - an alias header, which must parse exactly as the canonical one does;
 *  - a header carrying an extra column we do not know, which must now be DROPPED rather than
 *    refuse the file;
 *  - two spellings of one role, which must refuse with `ambiguous-column-mapping`;
 *  - a duplicated header, which must still refuse, because `toRecord` lets the later column
 *    overwrite the earlier one.
 *
 * Their counts are a NEW baseline rather than a comparison: they did not exist before, so no
 * before/after equality can be asserted over them.
 */
const aliasHeaderDoc = fc
	.constantFrom(
		'dateop;label;amount;category',
		'booking date;partner name;amount (eur);category',
		'started date;description;montant;category',
		'date;libelle;amount;iban',
		'date;label;amount;iban;solde;reference',
		'date;dateop;label;amount',
		'date;label;label;amount'
	)
	.chain((header) =>
		documentFor(
			header,
			[dateish, textish, amountish, textish, textish, textish].slice(0, header.split(';').length)
		)
	);
/**
 * `maison` refuses a row whose `type` disagrees with the sign of its `montant`, so drawing the two
 * independently refused about half of everything and left the calibration floor with 7 accepted
 * parses of headroom over 15 seeds. The pair is now drawn together, which lifts the minimum to a
 * margin worth having; the incoherent combination is still generated, at a lower weight, because
 * it is a refusal worth exercising rather than one worth avoiding.
 */
const maisonRow = fc
	.tuple(dateish, textish, textish, typeish, natureish, textish, fc.integer({ min: 0, max: 9 }))
	.map(([date, label, category, kind, nature, source, coherent]) => {
		const magnitude = ['12,34', '45,00', '7,50', '1 234,56'][coherent % 4];
		const signed =
			coherent < 8
				? `${kind === 'expense' ? '-' : ''}${magnitude}`
				: `${kind === 'expense' ? '' : '-'}${magnitude}`;
		return [date, label, category, signed, kind, nature, source].map(escapeCell).join(';');
	});
const maisonDoc = fc
	.array(maisonRow, { minLength: 1, maxLength: 5 })
	.map((rows) =>
		['date;libelle;categorie;montant;type;nature;source_bancaire', ...rows].join('\n')
	);
/**
 * Banque Populaire has thirteen columns, three of them dates and two of them amounts, so drawing
 * every cell from the shared arbitraries put its acceptance rate near 1 in 700 and the calibration
 * gate below fired at 2000 runs. Measured, not guessed: the gate named the profile. The fix is a
 * generator biased toward the shape a real export has (one side of the debit/credit pair filled),
 * not a lower floor, since a floor tuned down to what the generator happens to produce is not a
 * floor at all.
 */
const bpDoc = documentFor(BANQUE_POPULAIRE_HEADERS.join(';'), [
	dateish,
	textish,
	textish,
	textish,
	textish,
	textish,
	textish,
	textish,
	fc.oneof(
		{ arbitrary: fc.constantFrom('-45,00', '-7,50', '-1 234,56'), weight: 8 },
		{ arbitrary: amountish, weight: 2 }
	),
	fc.oneof({ arbitrary: fc.constant(''), weight: 8 }, { arbitrary: amountish, weight: 2 }),
	dateish,
	dateish,
	textish
]);

/** Revolut refuses any row whose État is not « Terminé » or whose Devise is not EUR, so a
 *  generator drawing those two cells from free text never reaches its accept path at all. */
const revolutDoc = documentFor(REVOLUT_HEADERS.join(';'), [
	textish,
	textish,
	dateish,
	dateish,
	textish,
	amountish,
	fc.oneof({ arbitrary: fc.constant(''), weight: 6 }, { arbitrary: amountish, weight: 4 }),
	fc.oneof(
		{ arbitrary: fc.constant('EUR'), weight: 8 },
		{ arbitrary: fc.constantFrom('USD', ''), weight: 2 }
	),
	fc.oneof(
		{ arbitrary: fc.constant('Terminé'), weight: 8 },
		{ arbitrary: fc.constantFrom('En attente', ''), weight: 2 }
	),
	fc.oneof({ arbitrary: fc.constant(''), weight: 6 }, { arbitrary: amountish, weight: 4 })
]);

/** maison-v2 needs a coherent group (one date, label and total across its lines, with parts that
 *  sum to it), which random cells reach essentially never. Built, then perturbed. */
const maisonV2Doc = fc
	.tuple(
		fc.constantFrom('2026-01-02', '2026-03-15', '2026-12-31'),
		fc.constantFrom('Carrefour', 'Loyer', 'Salaire'),
		fc.integer({ min: 2, max: 4 }),
		fc.constantFrom('expense', 'income'),
		fc.integer({ min: 0, max: 40 })
	)
	.map(([date, label, parts, kind, perturb]) => {
		const sign = kind === 'expense' ? '-' : '';
		const total = `${sign}${((parts * 1000) / 100).toFixed(2).replace('.', ',')}`;
		const lines: string[] = [];
		for (let index = 1; index <= parts; index += 1) {
			lines.push(
				[
					date,
					label,
					`Cat${index}`,
					`${sign}10,00`,
					kind,
					kind === 'expense' ? 'spending' : 'income',
					'src',
					total,
					`${index}/${parts}`,
					'Parent'
				].join(';')
			);
		}
		if (perturb < 10) {
			const cells = lines[0].split(';');
			cells[perturb % cells.length] = ['', '=cmd', '2026-13-45', 'NaN', '9/9'][perturb % 5];
			lines[0] = cells.join(';');
		}
		return [MAISON_V2_HEADER, ...lines].join('\n');
	});

const PROFILES = ['generic', 'maison', 'maison-v2', 'banque-populaire', 'revolut'] as const;

const labelled = fc.oneof(
	genericDoc.map((c) => ['generic', c] as const),
	// Labelled `generic` because that is the profile that PARSES it, which is the axis this
	// gate is counted on. Recorded because the label a result carries and the label of the
	// thing that produced the input are not the same question, and this gate has been read
	// wrongly on exactly that distinction before.
	aliasHeaderDoc.map((c) => ['generic', c] as const),
	maisonDoc.map((c) => ['maison', c] as const),
	maisonV2Doc.map((c) => ['maison-v2', c] as const),
	bpDoc.map((c) => ['banque-populaire', c] as const),
	revolutDoc.map((c) => ['revolut', c] as const)
);

const anyInput = fc.oneof(
	{ arbitrary: labelled, weight: 9 },
	{ arbitrary: fc.string({ maxLength: 300 }).map((c) => ['noise', c] as const), weight: 1 }
);

const RUNS = 2000;
const FLOOR = 10;

describe('the CSV parser under generated input', () => {
	it('refuses hostile input rather than raising, and reaches every profile while doing it', () => {
		expect.assertions(5);

		const throws: Array<{ error: string; input: string }> = [];
		const violations: string[] = [];
		const acceptedBy: Record<string, number> = {};
		const seenCodes = new Set<string>();
		let inputsCarryingACollisionGroup = 0;

		fc.assert(
			fc.property(anyInput, ([generatedAs, content]) => {
				const outcome = inspect(content);
				if (outcome.threw) throws.push({ error: outcome.threw, input: content });
				violations.push(...outcome.violations);
				if (outcome.accepted) acceptedBy[generatedAs] = (acceptedBy[generatedAs] ?? 0) + 1;
				if (outcome.collisionGroups > 0) inputsCarryingACollisionGroup += 1;
				for (const code of outcome.codes) seenCodes.add(code);
				return true;
			}),
			{ numRuns: RUNS }
		);

		// Named rather than counted: a count of zero is what an empty run also reports.
		expect(
			throws.map((t) => `${t.error} <- ${JSON.stringify(t.input).slice(0, 120)}`)
		).toStrictEqual([]);
		expect(violations).toStrictEqual([]);
		// The absolute figure that makes the two assertions above mean something. Without it they
		// are satisfied by a generator producing nothing a parser accepts, which is exactly the
		// state the first exploratory run was in when it reported 5000 clean refusals.
		//
		// THE FLOOR IS MEASURED, WITH MARGIN, AND THE SEED IS NOT PINNED. Minimum accepted parses
		// per profile over 15 seeds at 2000 runs: maison 25, revolut 36, generic 59,
		// banque-populaire 145, maison-v2 260. The floor sits at 10, comfortably under the
		// tightest, so an unlucky seed is not a red build while a generator that stops reaching a
		// profile is. Pinning the seed instead would make this deterministic and stop it being a
		// fuzzer; lowering the floor to whatever the generator happens to produce would stop it
		// being a floor.
		expect(PROFILES.filter((profile) => (acceptedBy[profile] ?? 0) < FLOOR)).toStrictEqual([]);

		// CALIBRATION FOR THE OCCURRENCE ORDINAL, and it exists for the same reason as the alias
		// calibration below: this gate was once measured BLIND to a change and reported identical
		// per profile counts on both sides, which reads as "nothing was reclassified" and meant
		// "the generator never emitted the shape".
		//
		// The shape here is a COLLISION GROUP: two accepted rows sharing date, folded label,
		// magnitude and direction. Before the ordinal those two collapsed into one transaction and
		// one `duplicateRows`; after it they are two transactions whose keys end `|0|` and `|1|`.
		// An input carrying no such group cannot tell the two versions apart, so a before-and-after
		// taken without this number compares two figures computed without the subject.
		//
		// MEASURED, WITH MARGIN, SEED NOT PINNED, like the floor above: 9, 10, 10, 11, 18 and 19
		// over six unpinned runs at 2000 runs each. The floor sits at 3, well under the tightest,
		// so an unlucky seed is not a red build while a generator that stops emitting repeated rows
		// is. Break-checked by reporting the count as a constant 0: red at "expected 0 to be
		// greater than or equal to 3".
		expect(inputsCarryingACollisionGroup).toBeGreaterThanOrEqual(3);

		// CALIBRATION FOR THE ALIAS SHAPES, and it exists because the gate was measured BLIND
		// to them. Pinning the seed across the alias change gave identical per profile counts
		// on both sides, which reads as "nothing was reclassified" and meant "the generator
		// only ever emitted the canonical header, so it never reached the new code".
		//
		// Accepting more is not evidence the collision path runs: acceptance proves resolution
		// works. These two codes prove the generator reaches the two guards that REFUSE, which
		// is the half a count of accepted parses structurally cannot show.
		expect([...seenCodes].sort()).toEqual(
			expect.arrayContaining(['ambiguous-column-mapping', 'duplicate-column'])
		);
	});

	it('never reports a refusal without a well-formed scope', () => {
		expect.assertions(1);

		const malformed: string[] = [];
		fc.assert(
			fc.property(anyInput, ([, content]) => {
				const result = parseCsvTransactions(content);
				// Every refusal carries a scope: a row points to a line the user can look at, and a
				// file or header level complaint has nowhere else to point. The empty-document case
				// carries the `file-empty` fact with { kind: 'file' } and no line, which is correct:
				// there is no line to name.
				for (const refusal of result.invalidRows) {
					const { scope } = refusal;
					const wellFormed =
						scope.kind === 'file' ||
						scope.kind === 'header' ||
						(scope.kind === 'row' && Number.isInteger(scope.line));
					if (!wellFormed) malformed.push(JSON.stringify(refusal));
				}
				return true;
			}),
			{ numRuns: RUNS }
		);

		expect(malformed).toStrictEqual([]);
	});
});

/**
 * The controls. Each one performs the thing the properties above forbid and requires the checker
 * to report it, so a clean run means the checker can see rather than that it looked.
 */
describe('the checker can see what it is looking for', () => {
	it('reports a throw when the parser raises, and a refusal when it returns', () => {
		expect.assertions(3);

		// The throw half first, because it is the bucket that cannot be exercised by any input
		// today: #275 is fixed, so nothing this parser is handed raises. A break that merged the
		// two buckets left every test in this file green until this line existed.
		expect(
			inspect('irrelevant', () => {
				throw new RangeError('Invalid time value');
			}).threw
		).toContain('RangeError');

		// Not a synthetic stub: this is the exact input that escaped as a RangeError before #275,
		// pointed at the real parser. It must now be REFUSED, and the checker must call it that.
		const content = [
			BANQUE_POPULAIRE_HEADERS.join(';'),
			[
				'2026-13-45',
				'x',
				'y',
				'r',
				'',
				'CB',
				'c',
				'',
				'-45,00',
				'',
				'2026-13-45',
				'2026-13-45',
				''
			].join(';')
		].join('\n');

		const outcome = inspect(content);

		expect(outcome.threw).toBeNull();
		expect(outcome.refused).toBe(true);
	});

	it('reports a formula character when one survives into a label', () => {
		expect.assertions(2);

		// Through `inspect`, not through a retyped copy of its predicate. The first version of
		// this control inlined the same regex, and blinding the real check in `inspect` left it
		// GREEN: a control that copies what it verifies verifies only its copy, and this is the
		// file whose whole subject is calibration.
		//
		// `sanitizeImportedText` prefixes a dangerous lead with an apostrophe, so a real import
		// cannot produce an unprefixed one. The checker is therefore handed a stub parser that
		// returns exactly what a broken sanitiser would.
		const outcome = inspect('irrelevant', () => leakingResult('=cmd|calc'));

		expect(outcome.violations).toStrictEqual(['formula character survives in label']);
		// And the real parser refuses to produce it, through the sanitiser rather than by luck.
		const parsed = parseCsvTransactions('date;label;amount\n2026-01-02;=cmd|calc;12,34');
		expect(parsed.transactions[0]?.label.startsWith("'")).toBe(true);
	});

	it('reports a non-integer amount, and a plain negative number is not mistaken for one', () => {
		expect.assertions(2);

		expect(Number.isInteger(Number.NaN)).toBe(false);
		// The false positive that cost 1492 phantom findings in the exploratory run.
		expect(PLAIN_NUMBER.test('-1234')).toBe(true);
	});
});
