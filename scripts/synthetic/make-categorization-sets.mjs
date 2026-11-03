#!/usr/bin/env node
/**
 * Two synthetic sets for measuring category suggestions (#1012, ruled in #1009), kept apart.
 *
 * ## Where the merchant names come from, which is the whole point of having two
 *
 * - `catalogue-brands.csv`: **every merchant is a rule catalogue entry**,
 *   `src/lib/server/categorization/default-rules/*.json`, read at run time, and nothing else:
 *   public brands, plus a few generic words (BOULANGERIE, LOYER) and public bodies (CAF). It
 *   measures the rules and history stages, because real bank labels name real brands. This is
 *   the one place in `scripts/synthetic/` whose merchants are NOT made up, and why it is not
 *   `make-synthetic.mjs`, whose promise (« every merchant is made up ») stands.
 * - `invented-merchants.csv`: **every merchant is a made-up word** behind a generic trade noun.
 *   It measures a model stage, whose purpose is the merchant nobody has seen: a real brand would
 *   let a model answer from what it memorised and flatter its figure. The spec proves only that
 *   no catalogue rule knows these names; a syllable that formed a real brand (BRIDOR, from
 *   « bri » and « dor ») was found by reading and removed. The trade noun carries the category,
 *   so this set measures an unseen NAME in a known trade, not an opaque label, and every credit
 *   is income: a figure quoted against it says so.
 *
 * A figure quoted against either set names the commit and the sha256 this script prints, because
 * the brand set is a function of the catalogue at that commit.
 *
 * No person, account or statement is involved: no holder, no balance, no account label. Each row
 * is a date, a bank-style label, an amount and the category it should receive.
 *
 * ## Deterministic on purpose
 *
 * No `Math.random`, no `Date.now`: a seeded mulberry32 walks the same sequence on every run, so a
 * figure quoted against a set can be re-derived. Two runs print the same hashes.
 *
 *   node scripts/synthetic/make-categorization-sets.mjs scr/synthetic/categorization
 *
 * `src/lib/server/categorization/syntheticSets.spec.ts` asserts both claims above through the
 * production matcher.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOGUE = fileURLToPath(
	new URL('../../src/lib/server/categorization/default-rules/', import.meta.url)
);
const FIRST_YEAR = 2024;
const FIRST_MONTH = 7; // July 2024 to June 2026
const MONTHS = 24;

/** Seeded PRNG, mulberry32. */
function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** How each category reaches a statement: the label prefix, the sign, and its cents range. */
const SHAPE = {
	food: { op: 'CB', min: 800, max: 14000 },
	dining: { op: 'CB', min: 600, max: 6500 },
	transport: { op: 'CB', min: 150, max: 9000 },
	housing: { op: 'PRLV SEPA', min: 2500, max: 95000, monthly: true },
	bills_energy: { op: 'PRLV SEPA', min: 1500, max: 16000, monthly: true },
	health: { op: 'CB', min: 500, max: 9000 },
	leisure: { op: 'CB', min: 700, max: 8000 },
	subscriptions: { op: 'PRLV SEPA', min: 499, max: 2999, monthly: true },
	shopping: { op: 'CB', min: 900, max: 25000 },
	travel: { op: 'CB', min: 3000, max: 60000 },
	income: { op: 'VIR SEPA', min: 15000, max: 320000, monthly: true, credit: true },
	savings: { op: 'VIR SEPA', min: 5000, max: 50000, monthly: true },
	investment: { op: 'VIR SEPA', min: 5000, max: 80000, monthly: true },
	other: { op: 'CB', min: 500, max: 10000 }
};

/**
 * The bank's spelling where a rule's display name is not one its pattern accepts. These rules are
 * narrow on purpose (a bare « BP » or « STEAM » overmatches), so the label carries the words a
 * statement does. The spec fails on any rule left out of here that needs to be in it.
 */
const BANK_SPELLING = {
	bills_totalenergies_energie: 'TOTALENERGIES ELEC',
	leisure_steam: 'STEAMPOWERED',
	transport_bp: 'BP STATION',
	transport_indigo_parking: 'INDIGO PARK'
};

function catalogueMerchants() {
	const files = readdirSync(CATALOGUE)
		.filter((f) => f.endsWith('.json'))
		.sort();
	return files.flatMap((f) =>
		JSON.parse(readFileSync(join(CATALOGUE, f), 'utf8')).map((rule) => ({
			name: BANK_SPELLING[rule.key] ?? (rule.name ?? rule.match).toUpperCase(),
			category: rule.targetCategoryKey
		}))
	);
}

/** Generic trade nouns per category; the merchant's own name is an invented word after it. */
const TRADES = {
	food: ['EPICERIE', 'PRIMEUR', 'FROMAGERIE', 'BOUCHERIE'],
	dining: ['BRASSERIE', 'BISTROT', 'CREPERIE', 'CANTINE'],
	transport: ['GARAGE', 'STATION', 'CARROSSERIE'],
	housing: ['AGENCE', 'SYNDIC', 'RESIDENCE'],
	bills_energy: ['ENERGIES', 'TELECOM', 'EAUX DE'],
	health: ['CABINET', 'LABORATOIRE', 'OPTIQUE', 'DENTAIRE'],
	leisure: ['CINEMA', 'THEATRE', 'CLUB', 'LUDOTHEQUE'],
	subscriptions: ['MAGAZINE', 'STUDIO', 'ABONNEMENT'],
	shopping: ['BOUTIQUE', 'BAZAR', 'QUINCAILLERIE', 'MAROQUINERIE'],
	travel: ['HOTEL', 'GITE', 'CAMPING', 'VOYAGES'],
	income: ['SARL', 'SAS', 'ATELIERS'],
	savings: ['EPARGNE'],
	investment: ['PLACEMENTS']
};
const SYLLABLES = ['va', 'lo', 'mi', 'ren', 'tu', 'sel', 'qua', 'bri', 'dul', 'ne', 'zu', 'pel'];

function inventedMerchants(rand) {
	const merchants = [];
	for (const [category, trades] of Object.entries(TRADES)) {
		for (let i = 0; i < 10; i++) {
			let word = '';
			for (let s = 0; s < 3; s++) word += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
			merchants.push({ name: `${trades[i % trades.length]} ${word.toUpperCase()}`, category });
		}
	}
	return merchants;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * One set. Every fourth merchant of a category, and the last of a category of two or three, first
 * appears in the second year, so a history stage can meet merchants it has seen and ones it has
 * not in every category; the spec checks that it does. Monthly categories post once a month on a fixed day; the
 * others post at a merchant-specific rate, with one row forced in their first month so every
 * merchant appears.
 */
function render(merchants, rand) {
	const rows = [];
	const sizes = Map.groupBy(merchants, (m) => m.category);
	const position = new Map();
	let lateCount = 0;
	merchants.forEach((merchant) => {
		const shape = SHAPE[merchant.category];
		const j = position.get(merchant.category) ?? 0;
		position.set(merchant.category, j + 1);
		const n = sizes.get(merchant.category).length;
		const late = j % 4 === 3 || (n >= 2 && n < 4 && j === n - 1);
		const firstMonth = late ? 12 + (lateCount++ % 12) : 0;
		const day = 1 + Math.floor(rand() * 28);
		const rate = 0.2 + rand() * 1.6;
		const base = shape.min + Math.floor(rand() * (shape.max - shape.min));
		for (let m = firstMonth; m < MONTHS; m++) {
			const count = shape.monthly
				? 1
				: Math.floor(rate) + (rand() < rate % 1 ? 1 : 0) || (m === firstMonth ? 1 : 0);
			for (let k = 0; k < count; k++) {
				const month = ((FIRST_MONTH - 1 + m) % 12) + 1;
				const year = FIRST_YEAR + Math.floor((FIRST_MONTH - 1 + m) / 12);
				const d = shape.monthly ? day : 1 + Math.floor(rand() * 28);
				const jitter = shape.monthly ? 1 : 0.6 + rand() * 0.8;
				const cents = Math.round(base * jitter) * (shape.credit ? 1 : -1);
				const suffix = shape.op === 'CB' ? ` ${pad(d)}/${pad(month)}` : '';
				rows.push([
					`${year}-${pad(month)}-${pad(d)}`,
					`${shape.op} ${merchant.name}${suffix}`,
					(cents / 100).toFixed(2),
					merchant.category
				]);
			}
		}
	});
	rows.sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
	);
	return ['date;label;amount;expected_category', ...rows.map((r) => r.join(';'))].join('\n') + '\n';
}

const out = process.argv[2];
if (!out) {
	console.error('usage: node scripts/synthetic/make-categorization-sets.mjs <output-directory>');
	process.exit(2);
}
mkdirSync(out, { recursive: true });
const SETS = {
	'catalogue-brands.csv': [catalogueMerchants(), prng(1012)],
	'invented-merchants.csv': [inventedMerchants(prng(1009)), prng(1013)]
};
for (const [name, [merchants, rand]] of Object.entries(SETS)) {
	const content = render(merchants, rand);
	writeFileSync(join(out, name), content, 'utf8');
	const rows = content.trimEnd().split('\n').slice(1);
	const months = new Set(rows.map((r) => r.slice(0, 7))).size;
	const sha = createHash('sha256').update(content).digest('hex');
	console.log(
		`${name}  rows ${rows.length} · months ${months} · merchants ${new Set(merchants.map((m) => m.name)).size} · sha256 ${sha}`
	);
}
