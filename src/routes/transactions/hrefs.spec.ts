import { describe, it, expect } from 'vitest';
import { buildTransactionsHref, buildTransactionsExportHref } from './hrefs';

const filters = {
	q: 'lisboa',
	qMode: 'contains',
	type: 'expense',
	category: 'Voyage',
	from: '2026-07-01',
	to: '2026-07-31',
	importBatchId: 'batch1234',
	ids: 'tx1,tx2',
	tag: 'tag1234a'
};

describe('buildTransactionsHref', () => {
	it('carries every active filter', () => {
		const href = buildTransactionsHref(filters, {}, { keepIds: true });
		const params = new URLSearchParams(href.split('?')[1]);

		expect(params.get('q')).toBe('lisboa');
		expect(params.get('type')).toBe('expense');
		expect(params.get('category')).toBe('Voyage');
		expect(params.get('from')).toBe('2026-07-01');
		expect(params.get('to')).toBe('2026-07-31');
		expect(params.get('importBatch')).toBe('batch1234');
		expect(params.get('tag')).toBe('tag1234a');
	});

	it('carries the tag filter through paging and row selection', () => {
		// Paging out of a tag-filtered view and landing on the unfiltered list is the same defect
		// the "Toutes" tab had: a control that silently drops the filter it was navigating within.
		const paged = new URLSearchParams(
			buildTransactionsHref(filters, { page: '2' }, { keepIds: true }).split('?')[1]
		);
		expect(paged.get('tag')).toBe('tag1234a');

		const selected = new URLSearchParams(
			buildTransactionsHref(filters, { selected: 'tx9' }, { keepIds: true }).split('?')[1]
		);
		expect(selected.get('tag')).toBe('tag1234a');
	});

	it('keeps the tag filter when the type tab changes', () => {
		// Unlike `ids`, a tag is an ordinary narrowing rather than a "these specific rows" view, so
		// switching tabs stays inside it instead of dropping it.
		const href = buildTransactionsHref(filters, { type: 'all' }, { keepIds: false });
		expect(new URLSearchParams(href.split('?')[1]).get('tag')).toBe('tag1234a');
	});

	it('emits qMode only for a regex search', () => {
		expect(
			new URLSearchParams(
				buildTransactionsHref({ ...filters, qMode: 'regex' }, {}, { keepIds: true }).split('?')[1]
			).get('qMode')
		).toBe('regex');
		expect(
			new URLSearchParams(buildTransactionsHref(filters, {}, { keepIds: true }).split('?')[1]).get(
				'qMode'
			)
		).toBeNull();
	});

	it('omits qMode when there is no search at all', () => {
		const href = buildTransactionsHref(
			{ ...filters, q: '', qMode: 'regex' },
			{},
			{ keepIds: true }
		);
		expect(new URLSearchParams(href.split('?')[1]).get('qMode')).toBeNull();
	});

	it('keeps ids when asked and drops them when not', () => {
		expect(
			new URLSearchParams(buildTransactionsHref(filters, {}, { keepIds: true }).split('?')[1]).get(
				'ids'
			)
		).toBe('tx1,tx2');
		expect(
			new URLSearchParams(buildTransactionsHref(filters, {}, { keepIds: false }).split('?')[1]).get(
				'ids'
			)
		).toBeNull();
	});

	it('omits type when it is all', () => {
		const href = buildTransactionsHref({ ...filters, type: 'all' }, {}, { keepIds: true });
		expect(new URLSearchParams(href.split('?')[1]).get('type')).toBeNull();
	});

	it('applies a type override', () => {
		// buildFocusHref set type=classify unconditionally; an override wins over the ambient value.
		const href = buildTransactionsHref(filters, { type: 'classify' }, { keepIds: false });
		expect(new URLSearchParams(href.split('?')[1]).get('type')).toBe('classify');
	});

	it('clears type when the override is all, even though the ambient filter is not', () => {
		// The regression this pins: the "Toutes" tab passes an `all` override while the ambient
		// filter is still `expense`. If the builder falls back to the ambient value whenever the
		// override is absent-or-all, that tab emits `type=expense` and is a dead link on exactly
		// the pages where it matters. The previous five builders keyed off the value they were
		// GIVEN, never the ambient one, so `all` has to suppress the parameter here too.
		const href = buildTransactionsHref(
			{ ...filters, type: 'expense' },
			{ type: 'all' },
			{ keepIds: false }
		);
		expect(new URLSearchParams(href.split('?')[1]).get('type')).toBeNull();
	});

	it('keeps a non-default ambient type when no override is given, for paging and selection', () => {
		// The other half of the contract, and the reason `all` cannot simply be dropped from the
		// override type: buildPageHref and buildSelectedHref must preserve the active filter.
		const href = buildTransactionsHref(
			{ ...filters, type: 'expense' },
			{ page: '2' },
			{
				keepIds: true
			}
		);
		expect(new URLSearchParams(href.split('?')[1]).get('type')).toBe('expense');
	});

	it('applies page and selected overrides', () => {
		const params = new URLSearchParams(
			buildTransactionsHref(filters, { page: '3', selected: 'tx9' }, { keepIds: true }).split(
				'?'
			)[1]
		);
		expect(params.get('page')).toBe('3');
		expect(params.get('selected')).toBe('tx9');
	});

	it('omits every empty filter rather than emitting blank params', () => {
		const href = buildTransactionsHref(
			{
				q: '',
				qMode: 'contains',
				type: 'all',
				category: '',
				from: '',
				to: '',
				importBatchId: '',
				ids: '',
				tag: ''
			},
			{},
			{ keepIds: true }
		);
		expect(href).toBe('/transactions?');
	});
});

describe('buildTransactionsExportHref', () => {
	it('always keeps ids', () => {
		// An export shows nothing, so a dropped ids filter would silently turn a five-row view into
		// a whole-history CSV. See the comment on the export branch.
		expect(new URLSearchParams(buildTransactionsExportHref(filters).split('?')[1]).get('ids')).toBe(
			'tx1,tx2'
		);
	});

	it('exports the tag-filtered set, not the whole history', () => {
		// Same reasoning as the ids case above: the user cannot inspect a download before it lands,
		// so a dropped filter here is worse than a dropped filter on screen.
		expect(new URLSearchParams(buildTransactionsExportHref(filters).split('?')[1]).get('tag')).toBe(
			'tag1234a'
		);
	});

	it('points at the export route', () => {
		expect(buildTransactionsExportHref(filters).startsWith('/transactions/export?')).toBe(true);
	});
});
