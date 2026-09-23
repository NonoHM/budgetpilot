import { describe, expect, it } from 'vitest';
import { designationView, type DesignationFile } from './columnDesignation';

/**
 * THE SEAM BETWEEN THE SERVER PAYLOAD AND THE SCREEN, which had nothing standing at it.
 *
 * `/import`'s action builds a `DesignationFile` and the designation screen draws one. Between them
 * the object is rebuilt FIELD BY FIELD, because the transport also carries the account resolution
 * and that must not travel inside the view. Every level around this crossing was covered:
 * `page.server.spec.ts` asserts the offer carries its fields, and the component specs assert each
 * row draws from its prop. Nothing asserted the value gets from one to the other, so two fields
 * added to the payload and not to the copy reached the screen as `undefined`, the Date row drew
 * nothing, and the whole suite stayed green.
 *
 * ## Why the fields are not listed in this file
 *
 * A spec naming `dateStates` would have been written by the same session that forgot `dateStates`.
 * The assertions are GENERATED from the payload's own keys, and the fixture is typed
 * `Required<DesignationFile>`, so adding an optional field to the interface makes THIS FILE fail to
 * compile until the fixture carries it. That is what makes the guard cover a field added tomorrow
 * rather than the two fields that happened to be forgotten yesterday.
 *
 * ## The two sides do not share a source
 *
 * This repository records that a comparison whose two sides derive from one source is an identity
 * wearing a check's clothes. Here one side has been through the function under test and the other
 * has not, and what is being asserted is precisely that the trip preserves it.
 */
const PAYLOAD: Required<DesignationFile> = {
	name: 'releve-2026-06.csv',
	headers: ['zone_1', 'zone_2', 'zone_3'],
	samples: [
		['01/02/2026', '03/04/2026', '05/06/2026'],
		['CARREFOUR', 'SNCF', 'EDF'],
		['-12,90', '-45,00', '-83,10']
	],
	firstRow: ['01/02/2026', 'CARREFOUR', '-12,90'],
	previewRows: [
		['01/02/2026', 'CARREFOUR', '-12,90'],
		['03/04/2026', 'SNCF', '-45,00']
	],
	coverage: [66, 66, 66],
	dateStates: ['ambiguous', 'no-dates', 'no-dates'],
	dateReadings: [
		{
			dayFirst: ['2026-02-01', '2026-04-03', '2026-06-05'],
			monthFirst: ['2026-01-02', '2026-03-04', '2026-05-06']
		},
		{ dayFirst: [null, null, null], monthFirst: [null, null, null] },
		{ dayFirst: [null, null, null], monthFirst: [null, null, null] }
	],
	rowCount: 66,
	detectedHeaderRow: true
};

describe('designationView', () => {
	/**
	 * Separates « the payload's field reached the screen » from « the copy dropped it and the screen
	 * read `undefined` ». Those are the two states the whole crossing has, and before this test
	 * existed they produced the identical green at every other level.
	 */
	it('carries every field the payload declares, enumerated from the payload', () => {
		expect.hasAssertions();
		const view = designationView(PAYLOAD);

		for (const key of Object.keys(PAYLOAD) as (keyof DesignationFile)[]) {
			expect(view[key], `the payload's \`${key}\` did not cross into the view`).toStrictEqual(
				PAYLOAD[key]
			);
		}
	});

	/**
	 * Separates « the copy is explicit » from « the copy is a spread ». The transport is a
	 * `DesignationFile` PLUS the account resolution, and a spread would carry the account into the
	 * view, which is the object this module's docstring calls untrusted and the server never reads
	 * back. Asserting only the fields above would go green under a spread, so the negative half is
	 * what makes the positive half mean what it says.
	 */
	it('does not carry what the transport adds beside the file', () => {
		expect.assertions(2);
		const withAccount = { ...PAYLOAD, account: { options: [], resolution: 'ask' } };

		const view = designationView(withAccount as DesignationFile);

		expect(Object.keys(view)).not.toContain('account');
		expect(Object.keys(view).sort()).toStrictEqual(Object.keys(PAYLOAD).sort());
	});
});
