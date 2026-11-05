import { describe, expect, it } from 'vitest';
import { EMPTY_ASSIGNMENT } from '$lib/domain/columnDesignation';
import { setDesignationFields } from './designationFields';

/** The fields a designation writes, as the door will read them. */
function fieldsOf(designation: Parameters<typeof setDesignationFields>[1]) {
	const body = new FormData();
	setDesignationFields(body, designation);
	return Object.fromEntries(body.entries());
}

const ROLES = { ...EMPTY_ASSIGNMENT, date: 0, label: 1, amount: 2 };

describe('setDesignationFields (#1213)', () => {
	it('writes a designated currency column of a headerless file', () => {
		expect(
			fieldsOf({
				assignment: { ...ROLES, currency: 3 },
				hasHeaderRow: false,
				currencyDeclined: false
			})
		).toEqual({ dateIndex: '0', labelIndex: '1', amountIndex: '2', currencyIndex: '3' });
	});

	it('writes « none » for a declined currency, so the door does not ask again', () => {
		expect(fieldsOf({ assignment: ROLES, hasHeaderRow: false, currencyDeclined: true })).toEqual({
			dateIndex: '0',
			labelIndex: '1',
			amountIndex: '2',
			currencyIndex: 'none'
		});
	});

	it('writes no currency field when nobody answered, so the door can ask', () => {
		expect(fieldsOf({ assignment: ROLES, hasHeaderRow: false, currencyDeclined: false })).toEqual({
			dateIndex: '0',
			labelIndex: '1',
			amountIndex: '2'
		});
	});

	it('writes no currency field with a header row, where names declare it', () => {
		expect(
			fieldsOf({
				assignment: { ...ROLES, currency: 3 },
				hasHeaderRow: true,
				currencyDeclined: true
			})
		).toEqual({ dateIndex: '0', labelIndex: '1', amountIndex: '2' });
	});
});
