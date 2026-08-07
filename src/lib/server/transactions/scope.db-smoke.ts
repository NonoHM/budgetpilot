import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { MAX_BULK_TAG_TRANSACTIONS } from '$lib/domain/tags';
import {
	DIMENSIONS,
	NAMED_ROWS,
	PRODUCTIVE_DIMENSIONS,
	pairwiseRows,
	type FilterRow
} from './scope-matrix';
import { load, actions } from '../../../routes/transactions/+page.server';
import { GET as exportGET } from '../../../routes/transactions/export/+server';

/**
 * The three sites that answer "which transactions match the current filter" must resolve the SAME
 * transaction set. They have three different projections, three different error contracts and
 * three different consumption shapes, so nothing but this stops them drifting.
 *
 * Modelled on the feedsCashFlowProjection anti-drift test and on totals.db-smoke.ts, and required
 * against a REAL engine for the reason CLAUDE.md gives under "Unit tests cannot see a wrong SQL
 * predicate": a fixture-injected unit test replaces the very SQL in question.
 *
 * WHAT MAKES THIS TEST TRUSTWORTHY, and the rule it is built to obey: it imports and calls the
 * REAL `load`, `actions.bulkTag` and export `GET`. It re-implements no part of any of them. A probe
 * that retypes the function under test tests the probe — that is not a hypothetical, it is how a
 * `parseIsoDate` audit on this repo certified a validator as sound while the real one answered 500
 * on `?from=2026-99-99`. Each site's set is DERIVED from what that site actually returns.
 *
 * WHAT THIS TEST CANNOT CATCH, measured rather than reasoned, and the reason it is written here:
 *
 * It compares the three sites AGAINST EACH OTHER. A defect in the predicate builder they SHARE
 * moves all three identically, so they still agree and this suite stays green. Proven by breaking
 * `buildTransactionWhere` on purpose so that an empty `?ids=` meant "no filter" instead of "match
 * nothing" — the single highest-consequence defect available in this module, since it would make
 * `bulkTag` act on every transaction the user owns. **All 3 tests here passed with that bug in
 * place.** The plan for this chantier claimed this suite would catch it; that was wrong.
 *
 * The two guards that DID catch it, both of which must therefore be kept:
 *   - `scope.spec.ts`'s "treats an empty ?ids= as match-nothing" — failed by name, immediately.
 *   - the golden master (`SCOPE_GOLDEN_OUT`) — 28 of 72 rows changed their resolved set, widening
 *     rather than narrowing (one row went from 0 ids to 11).
 *
 * The general form, which is now a standing principle in CLAUDE.md: **an anti-drift test guards
 * against future DIVERGENCE, not against a present COMMON error, so it can never be the sole guard
 * for a correctness property.** Comparing N implementations against each other proves they AGREE;
 * it says nothing about whether they are RIGHT, because a defect in anything they share moves all
 * of them identically and they go on agreeing.
 *
 * So: this suite guards DRIFT BETWEEN the three sites. Correctness of the shared predicate is
 * guarded by the unit spec and by the before/after golden diff. Do not delete either on the
 * grounds that "the agreement test covers it".
 *
 * See vitest.db.config.ts for how to run it.
 */

// Same refusal as totals.db-smoke.ts and crossProvider.db-smoke.ts, duplicated per file on purpose:
// this guard is what stops the suite writing to a developer's real dev.db, and a shared helper a
// file forgets to call is a worse failure than the duplication.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

/**
 * 260 transactions, and the figure is chosen against MAX_BULK_TAG_TRANSACTIONS (250) rather than
 * merely being "hundreds".
 *
 * The plan originally said 240, to keep the unfiltered case under the cap so bulkTag would answer
 * with a SET. That makes the cap unreachable from every row in the matrix — including the row the
 * plan itself requires, "one deliberately over-cap case" — because `?ids=` truncates at 250 and no
 * other dimension can widen past the fixture size. 260 gives both boundaries for real:
 *
 *   - `ids: covering-all` sends 260 segments, normalizeIdList truncates to 250, and 250 is NOT
 *     over the cap (`matched > 250` is false at exactly 250) — so that row exercises the last
 *     value that still returns a set.
 *   - the unfiltered row matches all 260 and bulkTag REFUSES, so that row exercises the refusal,
 *     and its assertion is that the refusal's count equals the size the other two sites agree on.
 *
 * Every label is unique and carries the row index, because the CSV export has no id column: the
 * label is how an exported row is mapped back to a transaction id. Two rows sharing a label would
 * silently shrink the export's set and read as a real disagreement.
 *
 * Every DATE is distinct, and that is a controlled variable rather than a detail. `load`'s paged
 * branch orders by `{ date: 'desc' }` with skip/take and NO id tiebreak, while
 * forEachTransactionBatch (the scan path) orders by `[{ date: 'desc' }, { id: 'desc' }]`. Under
 * tied dates the paged walk can repeat or omit a row across page boundaries, which would surface
 * here as a spurious disagreement between `load` and the other two. Distinct dates remove that
 * variable so this suite measures the refactor. THE TIEBREAK GAP IS A REAL PRE-EXISTING FINDING and
 * is reported as one — it is deliberately NOT fixed here, because changing the list's ordering is
 * an observable behaviour change and the acceptance criterion for this chantier is that the
 * before/after sets are byte-identical.
 */
const FIXTURE_SIZE = 260;

/** Label families. The index suffix makes every label unique; the prefix drives the `q` classes. */
const LABEL_PREFIXES = [
	'Café Crème', // accented — proves `contains` folds accents (normalizeForMatch)
	'A+B (test)', // regex metacharacters IN THE DATA, not in the pattern
	'VIREMENT SEPA',
	'CARREFOUR MARKET',
	'SNCF CONNECT'
] as const;

interface Fixture {
	userId: string;
	categoryRealName: string;
	/** Carried by PARTS only, never by a parent — the OD-1 proof at engine level. */
	categoryPartOnlyName: string;
	tagIds: string[];
	batchIds: string[];
	allIds: string[];
	subsetIds: string[];
	overCapIds: string[];
	labelToId: Map<string, string>;
	uncategorizedCategoryId: string;
}

let fixture: Fixture;

const isoDay = (index: number): Date => new Date(Date.UTC(2025, 5, 1 + index)); // 2025-06-01 + index days, all distinct

async function seedFixture(): Promise<Fixture> {
	const user = await prisma.user.create({
		data: {
			email: `scope-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			// Not a hash of anything, and never used to authenticate: nothing here logs in.
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	const userId = user.id;

	const account = await prisma.account.create({
		data: { userId, name: 'Scope smoke account' },
		select: { id: true }
	});

	const [realCategory, uncategorized, partOnlyCategory] = await Promise.all([
		prisma.category.create({
			data: { userId, name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
			select: { id: true, name: true }
		}),
		prisma.category.create({
			data: {
				userId,
				name: UNCLASSIFIED_CATEGORY,
				nameKey: computeNameKey(UNCLASSIFIED_CATEGORY)
			},
			select: { id: true }
		}),
		// DO NOT REMOVE THIS CATEGORY AS REDUNDANT. It looks like a third decorative fixture category
		// and it is the only thing making OD-1 provable: held by PARTS and by no parent, so a query
		// returning rows for it can only have gone through the splits branch of the category
		// predicate. Delete it and OD-1 itself could be deleted outright with every row of this
		// matrix still green, because `?category=Alimentation` reaches the répartie rows through
		// their PARENT regardless — the guard would be guarding nothing, silently.
		prisma.category.create({
			data: { userId, name: 'Maison', nameKey: computeNameKey('Maison') },
			select: { id: true, name: true }
		})
	]);

	const batches: Array<{ id: string }> = [];
	for (const index of [0, 1, 2]) {
		batches.push(
			await prisma.importBatch.create({
				data: { userId, source: 'csv', fileName: `scope-${index}.csv`, rowCount: 0 },
				select: { id: true }
			})
		);
	}

	const tags: Array<{ id: string }> = [];
	for (const name of ['Portugal', 'Pro', 'Vacances']) {
		tags.push(
			await prisma.tag.create({
				data: { userId, name, nameKey: computeNameKey(name), colorToken: 'lagoon' },
				select: { id: true }
			})
		);
	}

	const rows = Array.from({ length: FIXTURE_SIZE }, (_, index) => {
		const prefix = LABEL_PREFIXES[index % LABEL_PREFIXES.length];
		// The classify pile, through BOTH of its branches (see buildTransactionWhere): a
		// manualCategoryKey equal to the sentinel, and manualCategory null with the sentinel
		// categoryId. Exercising only one branch would leave the other's OR arm unproven.
		// 13 is COPRIME with the import-batch modulus (5) below, so the classify dimension and the
		// batch dimension stay independent. Sharing a modulus would make `type=classify` and
		// `importBatch=real` select overlapping-by-construction sets, and a matrix row combining them
		// would be testing an artefact of the fixture rather than the filter.
		//
		// Widening both piles to a quarter of the fixture was TRIED, on the plausible reasoning that
		// a 40-row pile intersected with a narrow range and a tag would resolve nothing. Measured: the
		// non-empty row count went DOWN, 22 to 21, because a larger pile leaves fewer rows for
		// `category=real`. Reverted. Recorded so the same change is not retried blind.
		const inPileByManual = index % 13 === 0;
		const inPileByCategory = index % 13 === 1;
		const manualCategory = inPileByManual
			? UNCLASSIFIED_CATEGORY
			: index % 7 === 0
				? 'Alimentation'
				: null;

		return {
			/**
			 * DETERMINISTIC ids, and this is what makes the golden master a real gate.
			 *
			 * With Prisma's `cuid()` default the fixture minted fresh random ids on every run, so the
			 * captured golden could NEVER be byte-identical across two invocations — the acceptance
			 * criterion for this whole chantier was unachievable by construction, and the only ways
			 * out were to normalise ids away (a weaker comparison, silently) or to declare a
			 * structural match (a judgement call, exactly what a golden master exists to remove).
			 * Found by the Task 3 implementer flagging its diff instead of explaining it away.
			 *
			 * The shape satisfies `normalizeId`'s `/^[a-z0-9_-]{8,64}$/i`, so `?ids=` still receives
			 * ids of the same kind a real URL carries. It also makes a failing row readable: an id
			 * names its own fixture index.
			 */
			id: `scope-fixture-${String(index).padStart(4, '0')}`,
			userId,
			accountId: account.id,
			categoryId: inPileByCategory ? uncategorized.id : realCategory.id,
			importBatchId:
				index % 5 === 0
					? batches[0].id
					: index % 5 === 1
						? batches[1].id
						: index % 5 === 2
							? batches[2].id
							: null,
			date: isoDay(index),
			label: `${prefix} ${index}`,
			amountCents: index % 3 === 0 ? 4_500 : 12_000,
			type: index % 3 === 0 ? 'income' : index % 3 === 1 ? 'expense' : null,
			source: 'csv',
			manualCategory,
			manualCategoryKey: manualCategory ? computeNameKey(manualCategory) : null
		};
	});

	// Deterministic ids mean a second run against the SAME database would collide on the primary
	// key. The refusal guards above already demand a throwaway, but failing with a unique-constraint
	// violation would read as an engine problem rather than "you reused the database".
	await prisma.transaction.deleteMany({ where: { id: { startsWith: 'scope-fixture-' } } });
	await prisma.transaction.createMany({ data: rows });

	const created = await prisma.transaction.findMany({
		where: { userId },
		select: { id: true, label: true },
		orderBy: { date: 'asc' }
	});

	// Tag links: overlapping on purpose, and overlapping the `q` families, so `q` x `tag` is a
	// non-empty intersection rather than a comparison over nothing.
	const links: Array<{ transactionId: string; tagId: string }> = [];
	created.forEach((row, index) => {
		if (index % 4 === 0) links.push({ transactionId: row.id, tagId: tags[0].id });
		if (index % 6 === 0) links.push({ transactionId: row.id, tagId: tags[1].id });
		if (index % 9 === 0) links.push({ transactionId: row.id, tagId: tags[2].id });
	});
	await prisma.transactionTag.createMany({ data: links });

	// Répartitions, on a modulus COPRIME with every other one in this fixture (13 for the classify
	// pile, 5 for the batches, 4/6/9 for the tags, 7 for the manual category, 3 for type/amount), so
	// the split dimension stays independent of all of them. Sharing a modulus would make a matrix row
	// combining two of them test an artefact of the fixture rather than the filters.
	//
	// Seeded at all because the alternative was measured and rejected: with no parts anywhere,
	// `?split=split` resolves the empty set on every row, and the class would be declared in the
	// matrix while proving nothing — the exact "declared exception that never moved" shape recorded
	// in CLAUDE.md. Two parts per répartie row, summing EXACTLY to the parent (asserted below), so
	// the fixture cannot drift into the remainder state the app treats as unreachable.
	//
	// One part carries a category NO PARENT holds. That is what makes OD-1 provable here rather than
	// merely present: `?category=<part-only>` can only return rows through the splits branch.
	const splitParents = created.filter((_, index) => index % 11 === 0);
	const parentAmountById = new Map(rows.map((row) => [row.id, row.amountCents]));
	const splitRows = splitParents.flatMap((row) => {
		const total = parentAmountById.get(row.id) ?? 0;
		const first = Math.trunc(total / 2);
		return [
			{ transactionId: row.id, categoryId: realCategory.id, amountCents: first, position: 0 },
			{
				transactionId: row.id,
				categoryId: partOnlyCategory.id,
				amountCents: total - first,
				position: 1
			}
		];
	});
	await prisma.transactionSplit.createMany({ data: splitRows });

	// The fixture is seeded with createMany rather than through replaceSplits — 260 rows, one
	// transaction each would be absurd — so the invariant replaceSplits enforces is asserted here
	// instead of assumed. A fixture that quietly violated it would make every figure downstream
	// describe a state the app cannot produce.
	for (const parent of splitParents) {
		const total = parentAmountById.get(parent.id) ?? 0;
		const parts = splitRows.filter((part) => part.transactionId === parent.id);
		const sum = parts.reduce((running, part) => running + part.amountCents, 0);
		if (parts.length < 2 || sum !== total) {
			throw new Error(
				`scope fixture: répartition of ${parent.id} is invalid (${parts.length} parts summing ${sum}, parent ${total})`
			);
		}
	}

	const allIds = created.map((row) => row.id);
	return {
		userId,
		categoryRealName: realCategory.name,
		categoryPartOnlyName: partOnlyCategory.name,
		tagIds: tags.map((tag) => tag.id),
		batchIds: batches.map((batch) => batch.id),
		allIds,
		// Spread across the whole fixture rather than `slice(0, 5)`, so it intersects every other
		// dimension — the tags, both classify-pile branches, each `q` label family and the narrow
		// date range. A subset taken from the head intersects almost nothing, and every matrix row
		// combining it with another filter then resolves to the empty set, which is a comparison
		// that proves nothing.
		subsetIds: allIds.filter((_, index) => index % 6 === 0),
		// 260 real ids: normalizeIdList's split limit truncates to 250, which is the last value that
		// still returns a set rather than a refusal.
		overCapIds: allIds,
		labelToId: new Map(created.map((row) => [row.label, row.id])),
		uncategorizedCategoryId: uncategorized.id
	};
}

beforeAll(async () => {
	fixture = await seedFixture();
}, 60_000);

/**
 * Every bulkTag row writes links, and they must be removed BETWEEN ROWS, not between tests.
 *
 * This was an `afterEach` at first, which looks right and is not: the whole matrix runs inside ONE
 * `it`, so `afterEach` fired once at the very end while tags piled up on the same transactions
 * throughout. After ten rows had tagged a given row it hit MAX_TAGS_PER_TRANSACTION and bulkTag
 * answered `over-tag-cap` — the suite reporting a disagreement that was entirely its own doing.
 *
 * Called explicitly at the end of each iteration for that reason. Keeping each row's answer
 * independent of its predecessors is what makes "newly linked IS the resolved set" true.
 */
async function removeSmokeTags(): Promise<void> {
	await prisma.transactionTag.deleteMany({
		where: { tag: { userId: fixture.userId, name: { startsWith: 'scope-smoke-' } } }
	});
	await prisma.tag.deleteMany({
		where: { userId: fixture.userId, name: { startsWith: 'scope-smoke-' } }
	});
}

afterEach(removeSmokeTags);

/* ------------------------------------------------------------------ *
 * Fixture coverage — asserted BEFORE any comparison runs.
 * ------------------------------------------------------------------ */

it('populates every dimension the matrix varies', async () => {
	const { userId, batchIds, tagIds, uncategorizedCategoryId } = fixture;
	const counts = {
		income: await prisma.transaction.count({ where: { userId, type: 'income' } }),
		expense: await prisma.transaction.count({ where: { userId, type: 'expense' } }),
		untyped: await prisma.transaction.count({ where: { userId, type: null } }),
		pileByManual: await prisma.transaction.count({
			where: { userId, manualCategoryKey: computeNameKey(UNCLASSIFIED_CATEGORY) }
		}),
		pileByCategory: await prisma.transaction.count({
			where: { userId, manualCategory: null, categoryId: uncategorizedCategoryId }
		}),
		manualCategoryReal: await prisma.transaction.count({
			where: { userId, manualCategoryKey: computeNameKey('Alimentation') }
		}),
		tagged0: await prisma.transaction.count({
			where: { userId, tags: { some: { tagId: tagIds[0] } } }
		}),
		tagged1: await prisma.transaction.count({
			where: { userId, tags: { some: { tagId: tagIds[1] } } }
		}),
		tagged2: await prisma.transaction.count({
			where: { userId, tags: { some: { tagId: tagIds[2] } } }
		}),
		untagged: await prisma.transaction.count({ where: { userId, tags: { none: {} } } }),
		batch0: await prisma.transaction.count({ where: { userId, importBatchId: batchIds[0] } }),
		batch1: await prisma.transaction.count({ where: { userId, importBatchId: batchIds[1] } }),
		batch2: await prisma.transaction.count({ where: { userId, importBatchId: batchIds[2] } }),
		noBatch: await prisma.transaction.count({ where: { userId, importBatchId: null } }),
		accented: await prisma.transaction.count({ where: { userId, label: { startsWith: 'Café' } } }),
		regexMeta: await prisma.transaction.count({ where: { userId, label: { startsWith: 'A+B' } } }),
		inNarrowRange: await prisma.transaction.count({
			where: {
				userId,
				date: {
					gte: new Date('2025-09-01T00:00:00.000Z'),
					lt: new Date('2025-12-01T00:00:00.000Z')
				}
			}
		})
	};

	// A comparison over an empty equivalence class is green and proves nothing. This is the
	// documented weakness of golden-master testing — it protects the paths the fixture happens to
	// cover — so the coverage is asserted rather than assumed.
	for (const [dimension, count] of Object.entries(counts)) {
		expect(
			count,
			`class "${dimension}" is empty; every matrix row using it would prove nothing`
		).toBeGreaterThan(0);
	}

	const total = await prisma.transaction.count({ where: { userId } });
	expect(total).toBe(FIXTURE_SIZE);
	// The two boundaries this fixture size exists to reach (see FIXTURE_SIZE).
	expect(total).toBeGreaterThan(MAX_BULK_TAG_TRANSACTIONS);
	expect(fixture.allIds.length).toBeGreaterThan(MAX_BULK_TAG_TRANSACTIONS);

	// Distinct dates are load-bearing for the page walk, not incidental — see FIXTURE_SIZE.
	const distinctDates = await prisma.transaction.findMany({
		where: { userId },
		select: { date: true },
		distinct: ['date']
	});
	expect(distinctDates).toHaveLength(FIXTURE_SIZE);
});

/* ------------------------------------------------------------------ *
 * CSV label parsing — calibrated against known values before it is trusted.
 * ------------------------------------------------------------------ */

/** Mirrors escapeCsvField's quoting (export/+server.ts): `"` doubles inside a quoted field. */
export function parseCsvLabel(line: string): string {
	// The label is the second `;`-separated field. Walk the line rather than split(';'), because a
	// quoted label may contain the separator.
	let index = 0;
	let field = 0;
	let value = '';
	let quoted = false;
	while (index < line.length) {
		const char = line[index];
		if (quoted) {
			if (char === '"' && line[index + 1] === '"') {
				value += '"';
				index += 2;
				continue;
			}
			if (char === '"') {
				quoted = false;
				index += 1;
				continue;
			}
			value += char;
			index += 1;
			continue;
		}
		if (char === '"' && value === '') {
			quoted = true;
			index += 1;
			continue;
		}
		if (char === ';') {
			if (field === 1) return value;
			field += 1;
			value = '';
			index += 1;
			continue;
		}
		value += char;
		index += 1;
	}
	return field === 1 ? value : '';
}

it('parses a CSV label whose value is already known', () => {
	// Calibration, not coverage. A label parser that silently returns '' would make every export
	// set look identically empty, and the three-way comparison would then be green on nothing.
	// Calibrate the harness against a known value before trusting a single figure it produces.
	expect(parseCsvLabel('2026-01-05;Café Crème 12;Alimentation;-12.00;expense;spending;csv')).toBe(
		'Café Crème 12'
	);
	expect(parseCsvLabel('2026-01-05;"A+B (test); 4";Alimentation;-12.00;expense;spending;csv')).toBe(
		'A+B (test); 4'
	);
	expect(
		parseCsvLabel('2026-01-05;"He said ""hi"" 9";Alimentation;-12.00;expense;spending;csv')
	).toBe('He said "hi" 9');
	// The formula-injection guard prefixes a leading `=` with an apostrophe; the label round-trips
	// with that prefix, so a fixture label must never start with one or the map lookup would miss.
	expect(parseCsvLabel("2026-01-05;'=SUM(A1);Alimentation;-12.00;expense;spending;csv")).toBe(
		"'=SUM(A1)"
	);
});

/* ------------------------------------------------------------------ *
 * Query-string construction from a matrix row.
 * ------------------------------------------------------------------ */

const NARROW_FROM = '2025-09-01';
const NARROW_TO = '2025-11-30';

export function buildQueryString(row: FilterRow, fx: Fixture): string {
	const params = new URLSearchParams();

	if (row.q === 'contains-some') params.set('q', 'creme'); // accent-folded match on "Café Crème"
	if (row.q === 'contains-none') params.set('q', 'zzz-no-such-label');
	if (row.q === 'regex-valid') {
		params.set('q', '^SNCF');
		params.set('qMode', 'regex');
	}
	if (row.q === 'regex-invalid') {
		params.set('q', '[');
		params.set('qMode', 'regex');
	}

	if (row.type !== 'all') params.set('type', row.type);

	if (row.category === 'real') params.set('category', fx.categoryRealName);
	// Only parts carry this one, so any row it returns came through the splits branch of the
	// category predicate — the whole point of the class.
	if (row.category === 'part-only') params.set('category', fx.categoryPartOnlyName);
	if (row.category === 'nonexistent') params.set('category', 'Aucune catégorie de ce nom');

	if (row.range === 'valid-narrow') {
		params.set('from', NARROW_FROM);
		params.set('to', NARROW_TO);
	}
	if (row.range === 'valid-covering-all') {
		params.set('from', '2020-01-01');
		params.set('to', '2030-01-01');
	}
	if (row.range === 'lone-from') params.set('from', NARROW_FROM);
	if (row.range === 'malformed') {
		params.set('from', '2026-99-99');
		params.set('to', NARROW_TO);
	}
	if (row.range === 'reversed') {
		params.set('from', NARROW_TO);
		params.set('to', NARROW_FROM);
	}

	if (row.importBatch === 'real') params.set('importBatch', fx.batchIds[0]);
	if (row.importBatch === 'nonexistent') params.set('importBatch', 'batch-that-does-not-exist');

	if (row.tag === 'real') params.set('tag', fx.tagIds[0]);
	if (row.tag === 'nonexistent') params.set('tag', 'tag-that-does-not-exist');

	if (row.ids === 'subset') params.set('ids', fx.subsetIds.join(','));
	if (row.ids === 'empty') params.set('ids', '');
	if (row.ids === 'all-malformed') params.set('ids', 'a,b, ,,c');
	if (row.ids === 'over-cap') params.set('ids', fx.overCapIds.join(','));
	if (row.ids === 'covering-all') params.set('ids', fx.allIds.join(','));

	// Same shape as `type` above, not `tag`/`category`: TransactionSplitFilter has no id lookup, so
	// its "off" class is the literal 'all' rather than an absent param.
	if (row.split !== 'all') params.set('split', row.split);

	return params.toString();
}

/** Rows every site must refuse outright. */
function isFailClosed(row: FilterRow): boolean {
	return (
		row.q === 'regex-invalid' ||
		row.range === 'lone-from' ||
		row.range === 'malformed' ||
		row.range === 'reversed'
	);
}

/* ------------------------------------------------------------------ *
 * The three site adapters. Each DERIVES its set from what the site returns.
 * ------------------------------------------------------------------ */

const authUser = () =>
	({ id: fixture.userId, email: 'scope-smoke@budgetpilot.invalid', role: 'USER' }) as never;

const listEvent = (qs: string) =>
	({ locals: { user: authUser() }, url: new URL(`http://localhost/transactions?${qs}`) }) as never;

interface LoadAnswer {
	ids: string[];
	/** The two refusal flags, captured because they are NOT derivable from the id set. */
	queryError: boolean;
	dateRangeError: boolean;
	/**
	 * The tag-free scope's size — the third field added here for the same reason as the other two,
	 * and the reason is now a pattern rather than an incident.
	 *
	 * `load` scans the TAG-FREE scope and re-applies the tag in JS, so inverting `collect()`'s
	 * `tagFree` flag produces the SAME id set: the golden would stay byte-identical, the three-way
	 * agreement suite would stay green, and only `tagScopeTotal` and the per-tag counts would move.
	 * That figure is what the tag dropdown's "Toutes" row reports, so getting it wrong tells the
	 * user that clearing the tag filter changes nothing.
	 */
	tagScopeTotal: number;
}

/**
 * `load`: walk EVERY page. One page is not the set.
 *
 * The two error flags are captured alongside the ids because a golden master only guards what it
 * INSPECTS, and this one used to inspect the id set alone. That blind spot hid a real regression:
 * the resolver reported one refusal reason at a time, so a URL with BOTH an unusable range and an
 * invalid regex lost the regex half — the list is empty either way, so every id-based comparison
 * stayed byte-identical while the page dropped the "expression régulière invalide" state from the
 * search field. Found by a reviewer reading the diff, not by this suite.
 *
 * The page renders the two flags independently (`+page.svelte`: `error={Boolean(data.queryError)}`
 * on the SearchBar, and a separate `{#if data.queryError}` message), so they are part of the
 * observable contract and belong in the golden.
 */
async function answerFromLoad(qs: string): Promise<LoadAnswer> {
	const first = (await load(listEvent(qs))) as {
		transactions: Array<{ id: string }>;
		pagination: { totalPages: number };
		queryError: boolean;
		dateRangeError: boolean;
		tagScopeTotal: number;
	};
	const ids = first.transactions.map((row) => row.id);
	for (let page = 2; page <= first.pagination.totalPages; page++) {
		const next = (await load(listEvent(`${qs}&page=${page}`))) as {
			transactions: Array<{ id: string }>;
		};
		ids.push(...next.transactions.map((row) => row.id));
	}
	return {
		ids: ids.sort(),
		queryError: Boolean(first.queryError),
		dateRangeError: Boolean(first.dateRangeError),
		tagScopeTotal: first.tagScopeTotal
	};
}

type BulkAnswer = { kind: 'set'; ids: string[] } | { kind: 'refused'; message: string };

/**
 * `bulkTag`: a FRESH tag name per row, so "newly linked" IS the resolved set. Re-using a name would
 * make the next row's answer "the rows that did not already have it", which is a different question.
 */
async function answerFromBulkTag(qs: string, tagName: string): Promise<BulkAnswer> {
	const body = new FormData();
	body.set('tagName', tagName);
	const result = (await actions.bulkTag({
		locals: { user: authUser() },
		request: new Request('http://localhost/transactions', { method: 'POST', body }),
		url: new URL(`http://localhost/transactions?${qs}`)
	} as never)) as
		| { status: number; data: { bulkTagError: string } }
		| { bulkTagEmpty: true }
		| { bulkTagResult: { transactionIds: string[] } };

	if ('status' in result) return { kind: 'refused', message: result.data.bulkTagError };
	if ('bulkTagEmpty' in result) return { kind: 'set', ids: [] };
	return { kind: 'set', ids: [...result.bulkTagResult.transactionIds].sort() };
}

type ExportAnswer = { kind: 'set'; ids: string[] } | { kind: 'status'; status: number };

/** `export`: parse the CSV and map rows back through the unique labels. */
async function answerFromExport(qs: string): Promise<ExportAnswer> {
	let response: Response;
	try {
		response = (await exportGET({
			locals: { user: authUser() },
			url: new URL(`http://localhost/transactions/export?${qs}`)
		} as never)) as Response;
	} catch (caught) {
		const status = (caught as { status?: number }).status;
		if (typeof status !== 'number') throw caught;
		return { kind: 'status', status };
	}

	const [, ...lines] = (await response.text()).split('\r\n').filter(Boolean);
	const ids = lines.map((line) => {
		const label = parseCsvLabel(line);
		const id = fixture.labelToId.get(label);
		// Never silently drop an unmapped row: that would shrink the export's set and read as a
		// disagreement with the other two sites, pointing at the app instead of at this parser.
		if (!id)
			throw new Error(`export row did not map back to a fixture id: ${JSON.stringify(line)}`);
		return id;
	});
	return { kind: 'set', ids: ids.sort() };
}

/* ------------------------------------------------------------------ *
 * The matrix.
 * ------------------------------------------------------------------ */

/**
 * Two pairwise sets, because they prove two different things.
 *
 * `DIMENSIONS` covers the whole parameter space including the barren classes, so it proves the
 * three sites agree on EMPTINESS and on REFUSAL. `PRODUCTIVE_DIMENSIONS` covers only the classes
 * that can return rows, so it proves they agree on ACTUAL SETS — which the first one barely does:
 * measured, 7 of its 55 rows resolved anything at all.
 *
 * De-duplicated, because the productive space is a subset and its rows can coincide.
 */
const ROWS: FilterRow[] = [
	...pairwiseRows(DIMENSIONS),
	...pairwiseRows(PRODUCTIVE_DIMENSIONS),
	...NAMED_ROWS
].filter(
	(row, index, all) =>
		all.findIndex((other) => JSON.stringify(other) === JSON.stringify(row)) === index
);

describe('the three /transactions filter sites', () => {
	it('resolve the same transaction set, for every matrix row', async () => {
		const golden: Record<string, unknown> = {};

		for (const [index, row] of ROWS.entries()) {
			const qs = buildQueryString(row, fixture);
			const label = `${index}: ${JSON.stringify(row)}`;

			const loadAnswer = await answerFromLoad(qs);
			const fromLoad = loadAnswer.ids;
			const fromBulk = await answerFromBulkTag(qs, `scope-smoke-${index}`);
			const fromExport = await answerFromExport(qs);

			if (isFailClosed(row)) {
				// Every site refuses, and none returns rows. Asserted against a RICH background
				// (the named rows cross each fail-closed class with several active filters), so
				// "fails closed" is proven to dominate active filters rather than to hold alone.
				expect(fromLoad, label).toEqual([]);
				expect(fromBulk.kind, label).toBe('refused');
				expect(fromExport, label).toEqual({ kind: 'status', status: 400 });

				// The page renders a different state for each reason, and BOTH can be true at once.
				// Asserted per-reason rather than as "some error happened", because the collapse of
				// two independent flags into one is exactly the regression this suite failed to see.
				expect(loadAnswer.dateRangeError, `${label} (dateRangeError)`).toBe(
					row.range === 'lone-from' || row.range === 'malformed' || row.range === 'reversed'
				);
				expect(loadAnswer.queryError, `${label} (queryError)`).toBe(row.q === 'regex-invalid');
			} else if (fromLoad.length > MAX_BULK_TAG_TRANSACTIONS) {
				// Over the cap bulkTag cannot answer with a set, so its refusal is its answer — and
				// the refusal NAMES a count, which must be the size the other two agree on. Compared
				// as the whole rendered message rather than by parsing a number out of it: building
				// the expected message from the expected count needs no parser, so there is no
				// second harness here to calibrate.
				expect(fromBulk, label).toEqual({
					kind: 'refused',
					message: m.tags_bulk_error_too_many({
						count: fromLoad.length,
						limit: MAX_BULK_TAG_TRANSACTIONS
					})
				});
				expect(fromExport, label).toEqual({ kind: 'set', ids: fromLoad });
			} else {
				expect(fromBulk, label).toEqual({ kind: 'set', ids: fromLoad });
				expect(fromExport, label).toEqual({ kind: 'set', ids: fromLoad });
			}

			/**
			 * `tagScopeTotal` ASSERTED, not merely captured — and the difference is the whole point.
			 *
			 * Putting the field in the golden JSON protects nothing on its own: `SCOPE_GOLDEN_OUT` is
			 * a manual capture this suite writes only when the env var is set, and nothing in
			 * `package.json` or CI ever diffs it. The golden is disposable acceptance evidence for a
			 * refactor; the permanent guard has to be an `expect()`. A field captured but never
			 * asserted is the "check that has never been seen to fail" this repo keeps finding.
			 *
			 * The defect it targets: inverting `collect()`'s `tagFree` flag makes `load` scan the
			 * tag-FILTERED scope, after which the JS re-filter is idempotent — so every id set stays
			 * byte-identical and the three-way agreement above stays green. Only this figure moves,
			 * and it is what the tag dropdown's "Toutes" row reports, so a wrong value tells the user
			 * that clearing the tag filter would change nothing.
			 *
			 * Derived INDEPENDENTLY: the same URL with `tag` removed, resolved through `load` itself.
			 * Not a second read of the same predicate — a different route to the same number, which
			 * is what makes disagreement meaningful.
			 */
			if (!isFailClosed(row) && row.tag !== 'absent') {
				const tagFreeParams = new URLSearchParams(qs);
				tagFreeParams.delete('tag');
				const tagFree = await answerFromLoad(tagFreeParams.toString());
				expect(loadAnswer.tagScopeTotal, `${label} (tagScopeTotal)`).toBe(tagFree.ids.length);
			}

			golden[label] = { fromLoad, fromBulk, fromExport, loadErrors: loadAnswer };
			// Between ROWS, not between tests — see removeSmokeTags.
			await removeSmokeTags();
		}

		if (process.env.SCOPE_GOLDEN_OUT) {
			writeFileSync(process.env.SCOPE_GOLDEN_OUT, JSON.stringify(golden, null, 2));
		}

		// The matrix must actually be the matrix. A generator regression that emitted two rows would
		// leave every assertion above green while proving almost nothing.
		expect(ROWS.length).toBeGreaterThan(36);

		/**
		 * ROW-LEVEL coverage, and the assertion this suite most needs.
		 *
		 * "Every dimension is non-empty in the fixture" is a claim about the FIXTURE. It passed on
		 * the first run of this suite while 48 of 55 matrix rows resolved the empty set at all three
		 * sites — three sites agreeing that nothing matches nothing, 87% of the time, reported as a
		 * green anti-drift suite. That is the golden-master coverage failure in its purest form:
		 * green, plausible, and guarding almost nothing.
		 *
		 * So the ROWS themselves are measured. A row that resolves a non-empty set through the
		 * set-agreement branch is the only kind that can catch a site quietly returning a superset.
		 *
		 * MEASURED, on SQLite, 2026-08-04: of 72 rows, 28 are fail-closed, 10 are empty by design
		 * (`ids: empty` and `ids: all-malformed` mean match-nothing), 12 are incidental empty
		 * intersections, and **22 resolve a non-empty set through the set-agreement branch**. The
		 * floor is 20 rather than 22 so ordinary fixture drift does not fail the build, while a
		 * collapse back toward the original 7 does.
		 *
		 * RE-MEASURED 2026-08-07, after the Répartition dimension and the `category: 'part-only'`
		 * class were added: **21**, not 22. Read off a deliberately impossible floor (999) rather
		 * than inferred, so the number is the suite's own and not an estimate. It went DOWN by one
		 * even though the fixture gained répartitions and a genuinely productive category class,
		 * because the greedy pairwise generator selects different rows once a dimension's cardinality
		 * changes — the same counter-intuitive direction already recorded at the classify-pile
		 * modulus, where widening the pile took the count from 22 to 21.
		 *
		 * The floor STAYS AT 20. The margin is now 1 rather than 2, and that is worth saying out
		 * loud: one more reshuffle of this kind will fail the build, and the correct response then is
		 * to give the fixture more to find, never to lower the floor.
		 *
		 * Do not lower this floor to make a run pass. It was already raised once by fixing the
		 * fixture — `subsetIds` was `allIds.slice(0, 5)`, which intersected almost nothing, and
		 * spreading it across the fixture took the count from 7 to 22.
		 */
		const rowsWithSets = Object.values(golden).filter(
			(entry) => (entry as { fromLoad: string[] }).fromLoad.length > 0
		);
		expect(
			rowsWithSets.length,
			'too few matrix rows resolve a non-empty set; the suite would be green on nothing'
		).toBeGreaterThanOrEqual(20);

		// ...and they must not all be the SAME set. Rows that all return the whole fixture would
		// satisfy the count above while never exercising a narrowing.
		const distinctSets = new Set(
			rowsWithSets.map((entry) => (entry as { fromLoad: string[] }).fromLoad.join(','))
		);
		expect(distinctSets.size, 'every non-empty row resolved the same set').toBeGreaterThanOrEqual(
			8
		);
	}, 600_000);
});
