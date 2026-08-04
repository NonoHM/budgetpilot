import { describe, expect, it } from 'vitest';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { resolveTransactionScope } from './scope';

const u = (qs: string) => new URL(`http://localhost/transactions?${qs}`);

describe('resolveTransactionScope', () => {
	it('returns the sql branch when no search is active, and its where is the whole answer', async () => {
		const scope = await resolveTransactionScope('user-a', u('type=income'));
		expect(scope.kind).toBe('sql');
		if (scope.kind !== 'sql') throw new Error('unreachable');
		expect(scope.where).toMatchObject({ userId: 'user-a', type: 'income' });
	});

	it('returns the scan branch when a search is active, and exposes no property named `where`', async () => {
		const scope = await resolveTransactionScope('user-a', u('q=cafe'));
		expect(scope.kind).toBe('scan');
		// The whole point of the union: on this branch the SQL predicate is NOT the answer, so it
		// does not carry the name a caller would reach for. Reaching for it is a type error, and
		// this asserts the runtime shape agrees with the type.
		expect(scope).not.toHaveProperty('where');
		if (scope.kind !== 'scan') throw new Error('unreachable');
		expect(scope.whereBeforeQuery).toMatchObject({ userId: 'user-a' });
		expect(typeof scope.collect).toBe('function');
	});

	it('returns invalid with NO predicate at all, so a caller ignoring the discriminant cannot query', async () => {
		const scope = await resolveTransactionScope('user-a', u('q=%5B&qMode=regex'));
		expect(scope.kind).toBe('invalid');
		if (scope.kind !== 'invalid') throw new Error('unreachable');
		expect(scope.reasons).toEqual({ range: false, regex: true });
		expect(scope).not.toHaveProperty('where');
		expect(scope).not.toHaveProperty('whereBeforeQuery');
		expect(scope).not.toHaveProperty('whereWithoutTag');
		expect(scope).not.toHaveProperty('whereWithoutTagBeforeQuery');
	});

	it('reports an unusable date range as invalid, on every unusable shape', async () => {
		// `2026-99-99` is here because it was a 500, not a rejection, until the range-calendar
		// chantier added the NaN guard to parseIsoDate: DATE_PATTERN counts digits, `new Date`
		// returns Invalid Date, and `toISOString()` THROWS rather than returning a sentinel.
		for (const qs of [
			'from=2026-01-01',
			'to=2026-12-31',
			'from=2026-99-99&to=2026-12-31',
			'from=2026-12-31&to=2026-01-01'
		]) {
			const scope = await resolveTransactionScope('user-a', u(qs));
			expect(scope.kind, qs).toBe('invalid');
			if (scope.kind !== 'invalid') throw new Error('unreachable');
			expect(scope.reasons, qs).toEqual({ range: true, regex: false });
		}
	});

	it('reports BOTH reasons when a URL is wrong in both ways', async () => {
		// This test replaces one that asserted the opposite — "rejects the range BEFORE the regex, so
		// one refusal reason is reported at a time" — which pinned a regression rather than a
		// requirement. The pre-refactor `load` computed the two flags independently, and the page
		// renders them independently: `error={Boolean(data.queryError)}` on the SearchBar plus its own
		// "expression régulière invalide" message, separately from the date-range state. Collapsing
		// them lost the regex half of the feedback for a URL that is wrong in both ways.
		//
		// Invisible to the golden master as it then was, because the LIST is empty either way — which
		// is why the golden now captures both flags too.
		const scope = await resolveTransactionScope(
			'user-a',
			u('from=2026-99-99&to=2025-01-01&q=%5B&qMode=regex')
		);
		if (scope.kind !== 'invalid') throw new Error('unreachable');
		expect(scope.reasons).toEqual({ range: true, regex: true });
	});

	it('carries userId on every branch that exposes a predicate', async () => {
		const sql = await resolveTransactionScope('user-a', u('tag=tag-abc123xyz'));
		const scan = await resolveTransactionScope('user-a', u('q=x&tag=tag-abc123xyz'));
		if (sql.kind !== 'sql' || scan.kind !== 'scan') throw new Error('unreachable');
		for (const where of [
			sql.where,
			sql.whereWithoutTag,
			scan.whereBeforeQuery,
			scan.whereWithoutTagBeforeQuery
		]) {
			expect(where.userId).toBe('user-a');
		}
	});

	it('treats an empty ?ids= as match-nothing, never as no filter', async () => {
		// The highest-consequence property in this module. If `[]` ever collapsed back to "no
		// filter", bulkTag would tag every transaction the user owns — worse than losing the userId
		// conjunct, which at least only exposes rows whose ids are already known and fails loudly on
		// a foreign one. This widens an ordinary user's own action to their entire history, silently,
		// behind a success banner.
		for (const qs of ['ids=', 'ids=%20,,', 'ids=a,b,c']) {
			const scope = await resolveTransactionScope('user-a', u(qs));
			if (scope.kind !== 'sql') throw new Error('unreachable');
			expect(scope.where.id, qs).toEqual({ in: [] });
		}
	});

	it('omits the id filter entirely when ?ids= is absent', async () => {
		const scope = await resolveTransactionScope('user-a', u(''));
		if (scope.kind !== 'sql') throw new Error('unreachable');
		expect(scope.where).not.toHaveProperty('id');
	});

	it('BUILDS the tag-free scope rather than destructuring it off the tagged one', async () => {
		// The equivalence the old rest-spread relied on, proven once here so the replacement is shown
		// to preserve behaviour rather than assumed to. The spread stops removing the conjunct the
		// moment a future filter moves the tag out of the top level; building it cannot.
		// `category` is present so TWO conditions exist and the builder takes its
		// `where.AND = conditions` branch. That matters: with a tag alone the collapse reads
		// `conditions[0].OR`, so a drifted tag conjunct would VANISH from `where` entirely rather
		// than hide inside it — a different bug, which this assertion would catch for the wrong
		// reason. Measured while breaking this check on purpose.
		const scope = await resolveTransactionScope(
			'user-a',
			u('tag=tag-abc123xyz&type=expense&category=Alimentation')
		);
		if (scope.kind !== 'sql') throw new Error('unreachable');

		// The claim, asserted wherever the conjunct lives rather than only at the top level: the
		// tag is IN the tagged scope and OUT of the tag-free one. Structural equality alone would
		// pass if the builder stopped emitting the tag at all.
		expect(JSON.stringify(scope.where)).toContain('tag-abc123xyz');
		expect(JSON.stringify(scope.whereWithoutTag)).not.toContain('tag-abc123xyz');

		// And the two agree in every other respect, which is what proves BUILDING it is equivalent
		// to the rest-spread it replaces rather than merely different.
		const { tags, ...spread } = scope.where;
		expect(tags).toEqual({ some: { tagId: 'tag-abc123xyz' } });
		expect(scope.whereWithoutTag).toEqual(spread);
		expect(scope.whereWithoutTag).not.toHaveProperty('tags');
	});

	it('uses a supplied uncategorizedCategoryId instead of resolving one', async () => {
		// `load` already resolves this id for the global "à classer" pile, so routing it through the
		// resolver must not cost a second query. `null` is a real value (the sentinel category does
		// not exist) and must reach the builder as match-nothing, not be mistaken for "not supplied".
		const supplied = await resolveTransactionScope('user-a', u('type=classify'), {
			uncategorizedCategoryId: 'cat-known'
		});
		if (supplied.kind !== 'sql') throw new Error('unreachable');
		expect(JSON.stringify(supplied.where)).toContain('cat-known');

		const absent = await resolveTransactionScope('user-a', u('type=classify'), {
			uncategorizedCategoryId: null
		});
		if (absent.kind !== 'sql') throw new Error('unreachable');
		expect(absent.where.OR).toEqual([
			{ manualCategoryKey: computeNameKey(UNCLASSIFIED_CATEGORY) },
			{ AND: [{ manualCategory: null }, { categoryId: '__none__' }] }
		]);
	});

	it('keeps the raw from/to for redisplay while refusing to query with them', async () => {
		const scope = await resolveTransactionScope('user-a', u('from=%2099%2F99%2F2026%20&to='));
		if (scope.kind !== 'invalid') throw new Error('unreachable');
		expect(scope.filters.fromParam).toBe('99/99/2026');
		expect(scope.filters.toParam).toBe('');
	});
});
