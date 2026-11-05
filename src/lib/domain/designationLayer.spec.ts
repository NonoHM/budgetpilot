import { describe, expect, it } from 'vitest';
import { DESIGNATION_LAYERS, layerAtSave, rowProvenance } from './designationLayer';

/**
 * #1207 C2b, the import onion's label (#1203): which layer produced the value a row shows, and which
 * layer the server stores when the member keeps it. Each assertion compares the whole value, because
 * a provenance present with the wrong layer satisfies any check written about its presence.
 */
describe('rowProvenance, the line under a prefilled row', () => {
	const detected = { remembered: null, hasHeaderRow: true, header: 'Montant' } as const;

	// Separates « detection designated this column » from « the member chose another one ».
	it('labels a value detection designated by its header, and drops it once the member changes it', () => {
		expect.assertions(2);
		expect(rowProvenance({ ...detected, role: 'amount', current: 2, detected: 2 })).toEqual({
			layer: 'rule',
			reason: { code: 'header', header: 'Montant' }
		});
		expect(rowProvenance({ ...detected, role: 'amount', current: 3, detected: 2 })).toBeNull();
	});

	// Separates a header match (rule) from a file proof: the date row names the proof of its order.
	it('labels a designated date by the order the file proves, not by its header', () => {
		expect.assertions(2);
		const date = { ...detected, role: 'date', current: 0, detected: 0, header: 'Date' } as const;
		expect(rowProvenance({ ...date, dateState: 'proven-day' })).toEqual({
			layer: 'file',
			reason: { code: 'date-order', order: 'day-first' }
		});
		// `proven-shape` is « nothing to decide » (ISO, or a day equal to its month): no order to name.
		expect(rowProvenance({ ...date, dateState: 'proven-shape' })).toEqual({
			layer: 'file',
			reason: { code: 'date-single-reading' }
		});
	});

	// Separates the headerless currency (a value shape, the file) from a header row's match.
	it('labels a headerless currency column as read from the file', () => {
		expect.assertions(1);
		expect(
			rowProvenance({
				role: 'currency',
				current: 3,
				detected: 3,
				remembered: null,
				hasHeaderRow: false
			})
		).toEqual({ layer: 'file', reason: { code: 'currency-codes' } });
	});

	// Separates a remembered column kept from the file, kept as the member's own, and one of unknown
	// origin (written before 1.4), and a remembered column the member then changed.
	it('labels a remembered column by what it was kept from, and drops it once changed', () => {
		expect.assertions(4);
		const base = { role: 'label', detected: null, hasHeaderRow: true } as const;
		const kept = (layer: (typeof DESIGNATION_LAYERS)[number] | null, current = 1) =>
			rowProvenance({ ...base, current, remembered: { index: 1, layer } });
		expect(kept('rule')).toEqual({ layer: 'remembered', reason: { code: 'kept', from: 'file' } });
		expect(kept('member')).toEqual({
			layer: 'remembered',
			reason: { code: 'kept', from: 'member' }
		});
		expect(kept(null)).toEqual({ layer: 'remembered', reason: { code: 'kept', from: 'unknown' } });
		expect(kept('rule', 4)).toBeNull();
	});

	// Separates a row holding no column from one holding the detected column.
	it('says nothing about a row that holds no column', () => {
		expect.assertions(1);
		expect(
			rowProvenance({ ...detected, role: 'category', current: null, detected: null })
		).toBeNull();
	});
});

describe('layerAtSave, the layer the server stores for one role', () => {
	// Each case separates one origin from the next one in the onion's order.
	it('stores the remembered layer, then the detected rule, then the member', () => {
		expect.assertions(5);
		expect(layerAtSave({ posted: 1, detected: 1, remembered: { index: 1, layer: 'member' } })).toBe(
			'member'
		);
		expect(layerAtSave({ posted: 1, detected: 1, remembered: null })).toBe('rule');
		expect(layerAtSave({ posted: 2, detected: 1, remembered: { index: 1, layer: 'rule' } })).toBe(
			'member'
		);
		expect(
			layerAtSave({ posted: 1, detected: null, remembered: { index: 1, layer: null } })
		).toBeNull();
		expect(layerAtSave({ posted: null, detected: 1, remembered: null })).toBeNull();
	});

	it('names the five onion layers, model included for B4, in the onion order', () => {
		expect.assertions(1);
		expect(DESIGNATION_LAYERS).toEqual(['remembered', 'file', 'rule', 'model', 'member']);
	});
});
