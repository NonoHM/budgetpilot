import { describe, expect, it } from 'vitest';
import { DESIGNATION_LAYERS, isMemberChoice, layerAtSave } from './designationLayer';

/**
 * #1278: a prefilled row says nothing about where its value came from, because the column name and
 * the sample beside it are the member's evidence (#1278's comparables reading, 2026-11-05). The one
 * fact a row still states is that a remembered column is the member's own earlier choice.
 */
describe('isMemberChoice, the one provenance a row still shows', () => {
	const remembered = (layer: (typeof DESIGNATION_LAYERS)[number] | null) => ({ index: 1, layer });

	// Separates « kept as the member's own » from every other stored origin.
	it('is true only for a remembered column stored as the member’s own', () => {
		expect.assertions(4);
		expect(isMemberChoice({ current: 1, remembered: remembered('member') })).toBe(true);
		expect(isMemberChoice({ current: 1, remembered: remembered('rule') })).toBe(false);
		expect(isMemberChoice({ current: 1, remembered: remembered('file') })).toBe(false);
		expect(isMemberChoice({ current: 1, remembered: remembered(null) })).toBe(false);
	});

	// Separates « the row still holds the remembered column » from « the member changed it now ».
	it('is false once the row holds another column, or none', () => {
		expect.assertions(4);
		expect(isMemberChoice({ current: 4, remembered: remembered('member') })).toBe(false);
		expect(isMemberChoice({ current: null, remembered: remembered('member') })).toBe(false);
		// The one value where only the null guard decides: an empty row whose remembered role is empty.
		expect(isMemberChoice({ current: null, remembered: { index: null, layer: 'member' } })).toBe(
			false
		);
		expect(isMemberChoice({ current: 1, remembered: null })).toBe(false);
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
