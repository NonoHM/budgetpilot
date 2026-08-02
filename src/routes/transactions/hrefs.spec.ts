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
	ids: 'tx1,tx2'
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

	it('applies a type override, including all which must still be emitted', () => {
		// buildFocusHref set type=classify unconditionally; an override is explicit, not filtered.
		const href = buildTransactionsHref(filters, { type: 'classify' }, { keepIds: false });
		expect(new URLSearchParams(href.split('?')[1]).get('type')).toBe('classify');
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
				ids: ''
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

	it('points at the export route', () => {
		expect(buildTransactionsExportHref(filters).startsWith('/transactions/export?')).toBe(true);
	});
});
