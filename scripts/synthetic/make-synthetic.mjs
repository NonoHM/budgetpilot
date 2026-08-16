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

const YEAR = 2026;
const MONTH = 6;

const pad = (n) => String(n).padStart(2, '0');
const iso = (day) => `${YEAR}-${pad(MONTH)}-${pad(day)}`;
const fr = (day) => `${pad(day)}/${pad(MONTH)}/${YEAR}`;
/**
 * The form the blind session's real bank wrote. ACCEPTED since the dot joined `/` and `-` as a
 * separator — kept as a fixture because it is the journey that has to keep completing.
 */
const dotted = (day) => `${pad(day)}.${pad(MONTH)}.${YEAR}`;
/** A two-digit year: still refused, and what a date-wall fixture needs now that dots import. */
const shortYear = (day) => `${pad(day)}/${pad(MONTH)}/${String(YEAR).slice(2)}`;
const dec = (cents) => (cents / 100).toFixed(2);
const decComma = (cents) => dec(cents).replace('.', ',');
const ref = (index) => `REF${String(100 + index).padStart(6, '0')}`;

/** Sorted, because a statement is chronological and a fixture that is not invites a sort bug. */
const rows = () => [...LEDGER].sort((a, b) => a.day - b.day);

const csv = (header, lines) => `${header}\n${lines.join('\n')}\n`;

/* ── The shapes ───────────────────────────────────────────────────────────────────────────── */

/** Banque Populaire: 13 columns, `;`, money split across two columns, debit pre-signed. */
function banquePopulaire(date = fr) {
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
	const lines = rows().map((r, i) => {
		const debit = r.cents < 0 ? decComma(r.cents) : '';
		const credit = r.cents > 0 ? decComma(r.cents) : '';
		const op = r.kind === 'card' ? 'Carte' : 'Virement';
		const long =
			r.kind === 'card'
				? `PAIEMENT CB ${r.label.toUpperCase()}`
				: `VIREMENT SEPA ${r.label.toUpperCase()}`;
		const info = r.kind === 'card' ? 'CARTE 4512' : HOLDER.toUpperCase();
		return [
			date(r.day),
			r.label.toUpperCase(),
			long,
			ref(i),
			info,
			op,
			r.cat,
			r.sub,
			debit,
			credit,
			date(r.day),
			date(r.day),
			''
		].join(';');
	});
	return csv(header, lines);
}

/** Revolut, in both the French and the English spellings of the same ten columns. */
function revolut(lang, date = iso) {
	const en = lang === 'en';
	const header = en
		? 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance'
		: 'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
	const state = en ? 'COMPLETED' : 'TERMINÉ';
	let balance = 120480;
	const lines = rows().map((r) => {
		balance += r.cents;
		const type = r.cents > 0 ? (r.kind === 'transfer' ? 'TRANSFER' : 'TOPUP') : 'CARD_PAYMENT';
		const stamp = `${date(r.day)} ${pad(8 + (r.day % 9))}:${pad((r.day * 7) % 60)}:00`;
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

/** This application's own export, v1 (seven columns) and v2 (ten, one line per allocation). */
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
 */
function neutral(style, date = iso) {
	const headers = {
		canonical: 'date,label,amount,category',
		accented: 'Date,Libellé,Montant,Catégorie',
		opaque: 'col_a,col_b,col_c,col_d',
		opaque2: 'champ_1,champ_2,champ_3,champ_4'
	};
	const lines = rows().map((r) => [date(r.day), r.label, dec(r.cents), r.cat].join(','));
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

function foreignCurrency() {
	return csv(
		'date,label,amount,category,currency',
		rows().map((r) => [iso(r.day), r.label, dec(r.cents), r.cat, 'GBP'].join(','))
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
	'foreign-currency.csv': foreignCurrency(),

	// The accented spelling the alias table misses.
	'accented-headers.csv': neutral('accented')
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
