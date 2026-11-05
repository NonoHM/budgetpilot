import { describe, expect, it } from 'vitest';
import { layersKeyOf, producibleLayers, storedLayers, UNKNOWN_LAYERS } from './layers';
import type { ColumnMappingInput } from './model';

const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'date',
	labelColumn: 'libelle',
	amountColumn: 'montant',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};
const LAYERS = {
	dateLayer: 'rule',
	labelLayer: 'member',
	amountLayer: 'rule',
	categoryLayer: null
} as const;

describe('storedLayers, the one reader of a mapping layers (#1207)', () => {
	// Separates « the layers were written for these columns » from « a writer that does not know
	// them (1.3, after a rollback) moved a column », which must read unknown, never the old layer.
	it('reads the layers only while the role columns are the ones they were written for', () => {
		expect.assertions(3);
		const row = { ...MAPPING, ...LAYERS, layersKey: layersKeyOf(MAPPING) };
		expect(storedLayers(row)).toEqual(LAYERS);
		expect(storedLayers({ ...row, labelColumn: 'detail' })).toEqual(UNKNOWN_LAYERS);
		expect(storedLayers({ ...row, layersKey: null })).toEqual(UNKNOWN_LAYERS);
	});
});

describe('producibleLayers, what a restore may write (#1207)', () => {
	// Separates a layer the save path can produce from one it cannot: no layer on an empty role,
	// never `file`, `model` or `remembered` on a stored role, never `rule` on the category.
	it('keeps a producible layer and drops every other one', () => {
		expect.assertions(2);
		expect(producibleLayers(MAPPING, LAYERS)).toEqual(LAYERS);
		expect(
			producibleLayers(MAPPING, {
				dateLayer: 'file',
				labelLayer: 'model',
				amountLayer: 'remembered',
				categoryLayer: 'member'
			})
		).toEqual(UNKNOWN_LAYERS);
	});

	it('never keeps rule on the category, which detection never designates', () => {
		expect.assertions(1);
		expect(
			producibleLayers(
				{ ...MAPPING, categoryColumn: 'categorie' },
				{ ...LAYERS, categoryLayer: 'rule' }
			)
		).toEqual({ ...LAYERS, categoryLayer: null });
	});
});
