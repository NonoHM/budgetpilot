import { describe, expect, it } from 'vitest';
import { isStatementAccount } from './account';

describe('isStatementAccount', () => {
	it('excludes the implicit manual-entry bucket', () => {
		expect(isStatementAccount({ source: 'manual' })).toBe(false);
	});

	it.each(['csv', 'revolut', 'banque_populaire', 'enablebanking', 'mock_connector'])(
		'includes %s, which is a source of statements',
		(source) => {
			expect(isStatementAccount({ source })).toBe(true);
		}
	);

	// The asymmetry this function is shaped by, asserted rather than described: a source nobody
	// has heard of is a statement source. An inclusion list that forgot a new connector would
	// HIDE a real account with nothing able to notice; this direction offers a destination the
	// user can see and correct.
	it('includes a source that did not exist when this was written', () => {
		expect(isStatementAccount({ source: 'a-connector-shipped-next-year' })).toBe(true);
	});
});
