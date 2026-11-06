import { describe, expect, it } from 'vitest';
import {
	layersKeyOf,
	producibleLayers,
	storedAmountSign,
	storedLayers,
	UNKNOWN_LAYERS
} from './layers';
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
/** The two kept-answer fields (#1294), answerless: the key and the reader both read them. */
const KEYED = { ...MAPPING, amountSign: null, amountSignAccountId: null };
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
		const row = { ...KEYED, ...LAYERS, layersKey: layersKeyOf(KEYED) };
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

	// Separates a name mapping, which a save writes, from a position one, which no save writes.
	it('keeps no layer on a position mapping', () => {
		expect.assertions(1);
		expect(
			producibleLayers(
				{
					...MAPPING,
					matchBy: 'position',
					dateColumn: null,
					labelColumn: null,
					amountColumn: null,
					dateIndex: 0,
					labelIndex: 1,
					amountIndex: 2
				},
				LAYERS
			)
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

describe('storedAmountSign, the one reader of the kept sign answer (#1294)', () => {
	const kept = (fields: { amountSign: string | null; amountSignAccountId: string | null }) => ({
		...MAPPING,
		...fields,
		layersKey: layersKeyOf({ ...MAPPING, ...fields })
	});

	// Positive control: an answer written under its key reads back with its account.
	it('reads an answer written under its key', () => {
		expect.assertions(1);
		expect(storedAmountSign(kept({ amountSign: 'out', amountSignAccountId: 'acc-1' }))).toEqual({
			sign: 'out',
			accountId: 'acc-1'
		});
	});

	// Separates « the closed pair is the allow list » from « any stored string is an answer »: a
	// value no writer produces (a tampered row) reads as no answer, never as one (ASVS 2.2.1).
	it('reads a value outside the closed pair as no answer, even under a matching key', () => {
		expect.assertions(1);
		expect(
			storedAmountSign(kept({ amountSign: 'expense', amountSignAccountId: 'acc-1' }))
		).toBeNull();
	});

	// Separates « an answer bound to no account is not applied » from « applied to every account ».
	it('reads an answer with no account as no answer', () => {
		expect.assertions(1);
		expect(storedAmountSign(kept({ amountSign: 'out', amountSignAccountId: '' }))).toBeNull();
	});
});
