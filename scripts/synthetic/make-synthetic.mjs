#!/usr/bin/env node
/**
 * Synthetic bank statements, for every fixture this project needs in a test, a PR, an issue or
 * a screenshot.
 *
 * ## The rule this exists to make keepable
 *
 * Nothing derived from a real statement goes anywhere public, and a rule that forbids without
 * offering a replacement gets broken the first day someone is in a hurry. So this names where
 * to go instead. Every figure below is invented; the holder is Paul Mercier, who does not
 * exist; every merchant is made up.
 *
 * **What is taken from reality is the SHAPE and nothing else** — the column names, their order,
 * the delimiter, the decimal comma, the debit/credit split with the debit column pre-signed
 * negative. That is what carries the engineering meaning, and it identifies nobody.
 *
 * ## Deterministic on purpose
 *
 * No `Math.random`, no `Date.now`. A test can pin a byte of this output and a screenshot taken
 * today matches one taken in a month. Amounts come from a small fixed table walked in order.
 *
 *   node scripts/synthetic/make-synthetic.mjs scr/synthetic/out
 *
 * ## Why this lives under `scripts/` and not beside the files it writes
 *
 * It is the SUBSTITUTE that makes the no-real-data rule keepable, and a rule whose substitute
 * exists on one machine is a rule that gets broken the first time somebody is in a hurry. Its
 * OUTPUT belongs in `scr/`, which is gitignored; the generator itself has to be here, tracked,
 * where the rule in CLAUDE.md can point at it by path.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOLDER = 'Paul Mercier';

/**
 * The ledger every shape is rendered from, so the profiles are comparable to each other: the
 * same eight movements, the same two totals, the same period, written eight different ways.
 *
 * Three debits open it, deliberately. A Banque Populaire export splits money across `Debit` and
 * `Credit`, and a sampler that takes the top rows then renders `Credit` as three blanks — which
 * is how a blind session came to designate `Debit` as the amount and lose a month of income.
 * Keeping the opening debits keeps that defect reproducible.
 */
const LEDGER = [
	{
		day: 1,
		label: 'Mercerie Lafayette',
		cents: -4520,
		cat: 'Alimentation',
		sub: 'Courses',
		kind: 'card'
	},
	{
		day: 2,
		label: 'Pharmacie du Pont',
		cents: -1890,
		cat: 'Sante',
		sub: 'Pharmacie',
		kind: 'card'
	},
	{
		day: 5,
		label: 'Transports Urbains',
		cents: -6200,
		cat: 'Transport',
		sub: 'Abonnement',
		kind: 'card'
	},
	{ day: 3, label: 'Salaire', cents: 245000, cat: 'Revenus', sub: 'Salaire', kind: 'transfer' },
	{
		day: 9,
		label: 'Librairie du Marche',
		cents: -2345,
		cat: 'Loisirs',
		sub: 'Livres',
		kind: 'card'
	},
	{
		day: 12,
		label: 'Remboursement mutuelle',
		cents: 7430,
		cat: 'Sante',
		sub: 'Remboursement',
		kind: 'transfer'
	},
	{
		day: 17,
		label: 'Garage Saint Pierre',
		cents: -21000,
		cat: 'Transport',
		sub: 'Entretien',
		kind: 'card'
	},
	{
		day: 24,
		label: 'Boulangerie Mercier',
		cents: -780,
		cat: 'Alimentation',
		sub: 'Boulangerie',
		kind: 'card'
	}
];

/**
 * A second ledger, whose every date reads correctly BOTH ways, so a file rendered from it makes
 * `detectDateOrder` return `ambiguous`.
 *
 * ## Why a second ledger and not a change to the first
 *
 * `LEDGER` walks days 1, 2, 3, 5, 9, 12, 17, 24. Day 17 cannot be a month, so it PROVES day-first
 * on its own, which is what makes six corpus files `resolved` and is load bearing for the #342
 * sparse-credit defect. The corpus needs both states, so it needs both ledgers.
 *
 * ## The state, named
 *
 * Every cell of every declared date column has both leading components at or below 12. In plain
 * terms: **no movement after the 12th of any month.** A first-twelve-days current account export,
 * which is what a user downloads part way through a month to see what has cleared, or what a card
 * whose cycle closes on the 12th produces. The period is the only unusual thing about it and the
 * user chose the period.
 *
 * There is no salary here, and that is the shape rather than an omission: the window closes before
 * payday. The day 5 credit keeps the Debit/Credit split exercised.
 *
 * ## THE PROPERTY, AND IT IS ASSERTED RATHER THAN DESCRIBED
 *
 * **The two readings must disagree on every row.** `detectDateOrder` takes
 * `ambiguousSample ??= match[0]`, so the FIRST ambiguous cell in file order becomes the evidence
 * the question screen shows a user. A cell like `02/02/2026` is ambiguous and reads identically
 * both ways, so a ledger opening on it would illustrate the question with the one case where the
 * question does not matter.
 *
 * Reaching the property costs one rule, `no day may equal the month`, and that rule is NOT the
 * property: it is how this ledger happens to satisfy it. `syntheticCorpus.spec.ts` asserts the
 * property itself, by parsing each emitted fixture under both readings and requiring every row to
 * move. Whoever edits these days next gets a red rather than a docstring nobody re-reads.
 */
const AMBIGUOUS_LEDGER = [
	{
		day: 1,
		month: 2,
		label: 'Abonnement Fibre Doriane',
		cents: -3990,
		cat: 'Logement',
		sub: 'Internet',
		kind: 'transfer'
	},
	{
		day: 3,
		month: 2,
		label: 'Primeur Sainte Anne',
		cents: -1745,
		cat: 'Alimentation',
		sub: 'Courses',
		kind: 'card'
	},
	{
		day: 5,
		month: 2,
		label: 'Remboursement Teleconsultation',
		cents: 4900,
		cat: 'Sante',
		sub: 'Remboursement',
		kind: 'transfer'
	},
	{
		day: 6,
		month: 2,
		label: 'Peage Autoroute Cevennes',
		cents: -1260,
		cat: 'Transport',
		sub: 'Peage',
		kind: 'card'
	},
	{
		day: 9,
		month: 2,
		label: 'Opticien Vallonge',
		cents: -8900,
		cat: 'Sante',
		sub: 'Optique',
		kind: 'card'
	},
	{
		day: 11,
		month: 2,
		label: 'Cordonnerie du Beffroi',
		cents: -2150,
		cat: 'Services',
		sub: 'Reparation',
		kind: 'card'
	}
];

const YEAR = 2026;
const MONTH = 6;

const pad = (n) => String(n).padStart(2, '0');
/**
 * Every formatter takes the month from the ROW, defaulting to `MONTH`.
 *
 * `LEDGER` carries no `month` and renders in June exactly as it always did; `AMBIGUOUS_LEDGER`
 * carries one, because its property is about both leading components and a fixed module-level
 * month would make the second of them a constant of the whole file rather than of a ledger.
 */
const iso = (day, month = MONTH) => `${YEAR}-${pad(month)}-${pad(day)}`;
const fr = (day, month = MONTH) => `${pad(day)}/${pad(month)}/${YEAR}`;
/**
 * The form the blind session's real bank wrote. ACCEPTED since the dot joined `/` and `-` as a
 * separator — kept as a fixture because it is the journey that has to keep completing.
 */
const dotted = (day, month = MONTH) => `${pad(day)}.${pad(month)}.${YEAR}`;
/** A two-digit year: still refused, and what a date-wall fixture needs now that dots import. */
const shortYear = (day, month = MONTH) => `${pad(day)}/${pad(month)}/${String(YEAR).slice(2)}`;
/**
 * The same day and month, written month first.
 *
 * ## THESE THREE FORMATTERS EXIST TO BUILD REFUSALS, NOT STATEMENTS
 *
 * No bank writes a file whose date columns contradict each other, and the search for one found
 * nothing. The only real-world producer the literature names for a REORDERED date column is a
 * spreadsheet round trip, and that is not this either: Excel writes a converted date unpadded
 * (`1/6/2026`) and `AMBIGUOUS_DATE_PATTERN` requires two digits, so such a cell is refused as
 * `invalid-date` and never reaches the detector at all. Measured end to end, 2026-09-14.
 *
 * So the fixtures below are built to put `mixed` in front of the code that has to react to it
 * (#622), and nobody should go looking for the bank that writes them. That sentence is here so the
 * search is not run a second time.
 *
 * The one shape a real user DOES reach is `misdesignatedReference` further down, where nothing in
 * the file contradicts anything: the user designated the wrong column.
 */
const frMonthFirst = (day, month = MONTH) => `${pad(month)}/${pad(day)}/${YEAR}`;
/** Even days month first, odd days day first, so one column proves both readings. */
const contradicting = (day, month = MONTH) =>
	day % 2 === 0 ? frMonthFirst(day, month) : fr(day, month);
const dec = (cents) => (cents / 100).toFixed(2);
const decComma = (cents) => dec(cents).replace('.', ',');
const ref = (index) => `REF${String(100 + index).padStart(6, '0')}`;

/**
 * Sorted, because a statement is chronological and a fixture that is not invites a sort bug.
 *
 * Takes the ledger rather than closing over one, so the shapes below render EITHER ledger through
 * the same row-building code. Two ledgers with two row builders is the copied-predicate shape, in
 * the one place nothing would ever notice them drifting apart.
 */
const rows = (ledger = LEDGER) => [...ledger].sort((a, b) => a.day - b.day);

const csv = (header, lines) => `${header}\n${lines.join('\n')}\n`;

/* ── The shapes ───────────────────────────────────────────────────────────────────────────── */

/** Banque Populaire: 13 columns, `;`, money split across two columns, debit pre-signed. */
function banquePopulaire(date = fr, ledger = LEDGER, valueDate = date) {
	const header = [
		'Date de comptabilisation',
		'Libelle simplifie',
		'Libelle operation',
		'Reference',
		'Informations complementaires',
		'Type operation',
		'Categorie',
		'Sous categorie',
		'Debit',
		'Credit',
		'Date operation',
		'Date de valeur',
		'Pointage operation'
	].join(';');
	const lines = rows(ledger).map((r, i) => {
		const debit = r.cents < 0 ? decComma(r.cents) : '';
		const credit = r.cents > 0 ? decComma(r.cents) : '';
		const op = r.kind === 'card' ? 'Carte' : 'Virement';
		const long =
			r.kind === 'card'
				? `PAIEMENT CB ${r.label.toUpperCase()}`
				: `VIREMENT SEPA ${r.label.toUpperCase()}`;
		const info = r.kind === 'card' ? 'CARTE 4512' : HOLDER.toUpperCase();
		return [
			date(r.day, r.month),
			r.label.toUpperCase(),
			long,
			ref(i),
			info,
			op,
			r.cat,
			r.sub,
			debit,
			credit,
			date(r.day, r.month),
			valueDate(r.day, r.month),
			''
		].join(';');
	});
	return csv(header, lines);
}

/** Revolut, in both the French and the English spellings of the same ten columns. */
function revolut(lang, date = iso, ledger = LEDGER) {
	const en = lang === 'en';
	const header = en
		? 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
		: 'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
	const state = en ? 'COMPLETED' : 'TERMINÉ';
	let balance = 120480;
	const lines = rows(ledger).map((r) => {
		balance += r.cents;
		const type = r.cents > 0 ? (r.kind === 'transfer' ? 'TRANSFER' : 'TOPUP') : 'CARD_PAYMENT';
		const stamp = `${date(r.day, r.month)} ${pad(8 + (r.day % 9))}:${pad((r.day * 7) % 60)}:00`;
		return [
			type,
			'Current',
			stamp,
			stamp,
			r.label,
			dec(r.cents),
			'0.00',
			'EUR',
			state,
			dec(balance)
		].join(',');
	});
	return csv(header, lines);
}

/**
 * This application's own export, v1 (seven columns) and v2 (ten, one line per allocation).
 *
 * **Deliberately NOT parameterised on a ledger, unlike the three shapes above.** This is the one
 * format this application WRITES, and it writes ISO, so an ambiguous `maison` file is a statement
 * no export of this app can produce. Leaving the parameter off makes that structural rather than a
 * choice somebody has to keep making: there is no way to ask for one.
 */
function maison(date = iso) {
	const header = 'date;libelle;categorie;montant;type;nature;source_bancaire';
	const lines = rows().map((r) =>
		[
			date(r.day),
			r.label,
			r.cat,
			dec(r.cents),
			r.cents >= 0 ? 'income' : 'expense',
			nature(r),
			'Banque Lafayette'
		].join(';')
	);
	return csv(header, lines);
}

function maisonV2() {
	const header =
		'date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;categorie_parent';
	const lines = [];
	for (const r of rows()) {
		// Exactly one movement is répartie, so the file exercises grouping without becoming a
		// file about répartitions.
		const parts =
			r.label === 'Mercerie Lafayette'
				? [
						{ cat: 'Alimentation', cents: -3020 },
						{ cat: 'Loisirs', cents: -1500 }
					]
				: [{ cat: r.cat, cents: r.cents }];
		parts.forEach((p, i) => {
			lines.push(
				[
					iso(r.day),
					r.label,
					p.cat,
					dec(p.cents),
					r.cents >= 0 ? 'income' : 'expense',
					nature(r),
					'Banque Lafayette',
					dec(r.cents),
					`${i + 1}/${parts.length}`,
					r.cat
				].join(';')
			);
		});
	}
	return csv(header, lines);
}

function nature(r) {
	if (r.label === 'Salaire') return 'income';
	if (r.label.startsWith('Remboursement')) return 'refund';
	return 'spending';
}

/**
 * A neutral four-column shape, in three header styles.
 *
 * `canonical` is what `generic` resolves through its alias table. `accented` is the spelling a
 * French bank actually writes, and the alias table does not fold diacritics, so it is refused.
 * `opaque` matches no alias at all and is what opens the designation screen — and it is a
 * SECOND opaque style rather than one, because a mapping is fingerprinted over the header row:
 * the second style is what reopens the screen on a machine where the first was memorised.
 *
 * `opaque3` is a THIRD for the same reason and not for a third reason. It carries the ambiguous
 * ledger, so it is the designation path's own ambiguous file; reusing `opaque`'s header row would
 * have given the two files one fingerprint, and a mapping memorised on the ISO-dated one would
 * then recognise the ambiguous one and skip the screen it exists to open.
 */
function neutral(style, date = iso, ledger = LEDGER) {
	const headers = {
		canonical: 'date,label,amount,category',
		accented: 'Date,Libellé,Montant,Catégorie',
		opaque: 'col_a,col_b,col_c,col_d',
		opaque2: 'champ_1,champ_2,champ_3,champ_4',
		opaque3: 'zone_1,zone_2,zone_3,zone_4'
	};
	const lines = rows(ledger).map((r) =>
		[date(r.day, r.month), r.label, dec(r.cents), r.cat].join(',')
	);
	return csv(headers[style], lines);
}

/** The two shapes the four closed roles cannot express, kept so their refusals stay testable. */
function splitDebitCredit() {
	return csv(
		'Date;Libelle;Debit;Credit',
		rows().map((r) =>
			[
				fr(r.day),
				r.label,
				r.cents < 0 ? decComma(-r.cents) : '',
				r.cents > 0 ? decComma(r.cents) : ''
			].join(';')
		)
	);
}

function signIndicator() {
	return csv(
		'date,label,amount,sens',
		rows().map((r) =>
			[iso(r.day), r.label, dec(Math.abs(r.cents)), r.cents < 0 ? 'D' : 'C'].join(',')
		)
	);
}

/**
 * The only fixture with NO TITLE ROW: its first line is a movement.
 *
 * Hand made and living on one machine until #624, which is why it is here. It was a copy of the
 * `HEADERLESS` constant that two specs also hold inline, so the corpus carried a file that was a
 * rendering of a SPEC rather than of the ledger every one of its siblings renders: a merchant
 * (`Fleuriste Bellevue`) and a day (the 7th) that appear in no ledger at all. The specs keep their
 * own inline fixtures, which is right for a unit spec; the corpus file is a ledger rendering, which
 * is what makes it comparable to the rest of the corpus.
 *
 * `hasHeaderRow: false` is the answer a parse of this needs, and a parse that assumes otherwise
 * silently drops its first movement.
 */
function headerless(date = iso, ledger = LEDGER) {
	return `${rows(ledger)
		.map((r) => [date(r.day, r.month), r.label, dec(r.cents)].join(','))
		.join('\n')}\n`;
}

/**
 * Thirteen opaque columns, one signed amount, and the date repeated three times.
 *
 * The widest shape the designation screen has to lay out, and the only one with more than one
 * candidate date column behind opaque headers.
 *
 * ## THE CAUTIONARY TALE OF THIS CORPUS, AND IT IS WORTH READING BEFORE ADDING A FIXTURE BY HAND
 *
 * Hand made until #624, and the hand-made version had drifted in a way nothing could see. Dates
 * right. Amounts right. Every one of the eight movements filed under `Alimentation / Courses` and
 * typed `Carte`, **salary included** — a 2 450 euro credit, presented as a card payment at a
 * grocer. Nothing looked wrong, because everything a reader checks first was correct.
 *
 * That is a fixture that LIES QUIETLY, and it was sitting inside the corpus this project uses as
 * the denominator for a figure it then reasons from. A corpus is not a pile of examples; it is the
 * population every count is taken over, so a fixture that misrepresents its own shape corrupts
 * conclusions far from itself and does it silently.
 *
 * `syntheticCorpus.spec.ts` pins both columns against the movement now, which is the only reason
 * a regenerated one cannot drift back.
 *
 * Deliberately NOT `banquePopulaire` behind opaque headers, which would have been the shorter
 * spelling: that profile splits money across `Debit` and `Credit`, and this fixture's job is a
 * SINGLE signed amount column a user can designate. Two different things.
 */
function wide(date = fr, ledger = LEDGER) {
	const header = Array.from({ length: 13 }, (_, i) => `zone_${i + 1}`).join(',');
	const lines = rows(ledger).map((r, i) =>
		[
			date(r.day, r.month),
			r.label,
			ref(i),
			r.kind === 'card' ? 'CARTE 4512' : HOLDER.toUpperCase(),
			r.kind === 'card' ? 'Carte' : 'Virement',
			r.cat,
			r.sub,
			date(r.day, r.month),
			dec(r.cents),
			'',
			date(r.day, r.month),
			'O',
			''
		].join(',')
	);
	return csv(header, lines);
}

/**
 * A clean ISO date column beside a REFERENCE column that happens to carry the ambiguous grammar.
 *
 * The one refusal fixture here that a real user reaches, and they reach it by designating the
 * wrong column: nothing in this file contradicts anything. `poste_1` is a perfectly good date
 * column and the file imports the moment it is named. Designating `poste_2` refuses the whole
 * file and tells the user their file writes its dates in two orders, which is false about the
 * file and true about the column they chose. #622's second defect.
 *
 * Opaque headers, in a fingerprint no other fixture uses, because reaching this needs the
 * designation screen.
 */
function misdesignatedReference(ledger = LEDGER) {
	const header = 'poste_1,poste_2,poste_3,poste_4';
	const lines = rows(ledger).map((r) =>
		[iso(r.day, r.month), contradicting(r.day, r.month), r.label, dec(r.cents)].join(',')
	);
	return csv(header, lines);
}

/** A generic file whose `currency` column declares `code` on every row. */
function declaredCurrency(code) {
	return csv(
		'date,label,amount,category,currency',
		rows().map((r) => [iso(r.day), r.label, dec(r.cents), r.cat, code].join(','))
	);
}

/* ── Emit ─────────────────────────────────────────────────────────────────────────────────── */

const FILES = {
	// One per profile, for the regression comparison.
	'banque-populaire.csv': banquePopulaire(),
	'revolut-fr.csv': revolut('fr'),
	'revolut-en.csv': revolut('en'),
	'maison.csv': maison(),
	'maison-v2.csv': maisonV2(),
	'generic.csv': neutral('canonical'),

	// THE DATE WALL: headers a profile recognises, values it cannot read. `dd.mm.yyyy` is the
	// form the blind session's bank writes and the one no profile accepts.
	'date-wall-banque-populaire.csv': banquePopulaire(dotted),
	'date-wall-generic.csv': neutral('canonical', dotted),
	'date-wall-maison.csv': maison(dotted),
	'date-wall-revolut-fr.csv': revolut('fr', dotted),

	// Dates nothing can read, on a recognised profile: the refusal screen's own fixture.
	'unreadable-dates-generic.csv': neutral('canonical', shortYear),
	'unreadable-dates-banque-populaire.csv': banquePopulaire(shortYear),

	// Headers nothing recognises, in two fingerprints.
	'opaque-headers.csv': neutral('opaque'),
	'opaque-headers-2.csv': neutral('opaque2'),

	// The refusals that naming a column provably cannot repair.
	'split-debit-credit.csv': splitDebitCredit(),
	'sign-indicator.csv': signIndicator(),
	'foreign-currency.csv': declaredCurrency('GBP'),

	// A currency the file DECLARES and the app accepts: imports into a EUR account, refused into an
	// account held in another currency (#600), whose walk needs a file that says EUR.
	'declared-eur.csv': declaredCurrency('EUR'),

	// The accented spelling the alias table misses.
	'accented-headers.csv': neutral('accented'),

	// The two shapes that were hand made and untracked until #624. A denominator that rests on
	// files a cloner cannot produce is not a denominator.
	'headerless.csv': headerless(),
	'wide.csv': wide(),

	// MIXED: the two causes #622 needs to be able to tell apart, plus the misdiagnosis. Refusal
	// states rather than statements: see `frMonthFirst` for why no bank writes the first two.
	'mixed-across-columns-banque-populaire.csv': banquePopulaire(fr, LEDGER, frMonthFirst),
	'mixed-within-column-generic.csv': neutral('canonical', contradicting),
	'misdesignated-reference-column.csv': misdesignatedReference(),

	// AMBIGUOUS: every cell reads both ways, so the file asks a question the bytes cannot answer.
	// Three shapes rather than six, because the declared-column count is the axis that matters
	// here: the verdict is taken over the UNION of a profile's declared columns, so a shape with
	// three of them is a different test from one with a single column. `maison` is absent for the
	// reason its own docstring gives.
	'ambiguous-banque-populaire.csv': banquePopulaire(fr, AMBIGUOUS_LEDGER),
	'ambiguous-revolut-fr.csv': revolut('fr', fr, AMBIGUOUS_LEDGER),
	'ambiguous-generic.csv': neutral('canonical', fr, AMBIGUOUS_LEDGER),

	// The same question on the OTHER path. The three above resolve a profile, so they ask it where
	// the file was recognised; this one resolves no usable profile and is refused on its header, so
	// it asks it where a human has just named the column. That is the designation screen, and it
	// had no ambiguous fixture at all.
	'ambiguous-opaque-headers.csv': neutral('opaque3', fr, AMBIGUOUS_LEDGER)
};

const out = process.argv[2];
if (!out) {
	console.error('usage: node scr/synthetic/make-synthetic.mjs <output-directory>');
	process.exit(2);
}
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(FILES)) {
	writeFileSync(join(out, name), content, 'utf8');
	console.log(`${name}  ${content.split('\n').length - 1} lines`);
}
console.log(
	`\nholder: ${HOLDER} (invented) · ${LEDGER.length} movements · period ${iso(1)}..${iso(24)}`
);
