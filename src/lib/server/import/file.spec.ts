import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ImportFileError, readImportFile } from './file';

describe('readImportFile', () => {
	it('rejette un fichier .xlsx dont le contenu n’est pas un vrai ZIP (extension usurpée)', async () => {
		expect.assertions(2);

		const file = new File(['ceci n’est pas un fichier xlsx'], 'faux.xlsx', {
			type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		});

		await expect(readImportFile(file)).rejects.toThrow(ImportFileError);
		await expect(readImportFile(file)).rejects.toMatchObject({ code: 'bad_extension' });
	});

	/**
	 * #595: a REAL archive that is not a workbook. The signature check above passes on it, because
	 * `PK\x03\x04` is shared by every ZIP-based format, and `read-excel-file` used to throw a raw
	 * `Error` naming the missing part, which the routes rethrew into a bare 500.
	 *
	 * Built with fflate's `zipSync`, which writes a real central directory: the issue records that a
	 * hand-assembled archive failed the expansion measurement as MALFORMED and read as « does not
	 * reproduce ». The calibration below is what proves these archives reach `readSheet` at all: the
	 * same builder, given the parts of a workbook, reads.
	 */
	describe('#595: an archive that is not a workbook', () => {
		const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		const asFile = (bytes: Uint8Array, name: string) =>
			new File([bytes as Uint8Array<ArrayBuffer>], name, { type: XLSX });

		it('CALIBRATION: the same builder, given a workbook’s parts, reads its row', async () => {
			expect.assertions(1);
			const workbook = zipSync({
				'[Content_Types].xml': strToU8(
					'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
				),
				'_rels/.rels': strToU8(
					'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
				),
				'xl/workbook.xml': strToU8(
					'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
				),
				'xl/_rels/workbook.xml.rels': strToU8(
					'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
				),
				'xl/worksheets/sheet1.xml': strToU8(
					'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>date</t></is></c><c r="B1" t="inlineStr"><is><t>montant</t></is></c></row></sheetData></worksheet>'
				)
			});

			const result = await readImportFile(asFile(workbook, 'classeur.xlsx'));

			expect(result.rows[0].cells).toEqual(['date', 'montant']);
		});

		it('refuses an archive holding one text file as an unreadable workbook', async () => {
			expect.assertions(1);
			const archive = zipSync({ 'notes.txt': strToU8('ceci est une archive, pas un classeur') });

			await expect(readImportFile(asFile(archive, 'x.xlsx'))).rejects.toMatchObject({
				name: 'ImportFileError',
				code: 'unreadable_workbook'
			});
		});

		it('refuses an archive holding only a docProps directory, the issue’s second shape', async () => {
			expect.assertions(1);
			const archive = zipSync({
				'docProps/app.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Properties/>')
			});

			await expect(readImportFile(asFile(archive, 'x.xlsx'))).rejects.toMatchObject({
				name: 'ImportFileError',
				code: 'unreadable_workbook'
			});
		});
	});

	it('retourne des lignes normalisées sans modifier les montants', async () => {
		expect.assertions(4);

		const file = new File(
			[
				'Type,Produit,Date de dÃ©but,Date de fin,Description,Montant,Frais,Devise,Ã‰tat,Solde\n' +
					'Ajout de fonds,Valeur actuelle,2026-05-04 18:52:52,2026-05-04 18:53:06,Recharge via *2593,+60.00,0.00,EUR,TERMINÃ‰,73.98'
			],
			'revolut.csv',
			{ type: 'text/csv' }
		);

		const result = await readImportFile(file);

		expect(result.rows[0].cells).toContain('Date de début');
		expect(result.rows[0].cells).toContain('État');
		expect(result.rows[1].cells).toContain('TERMINÉ');
		expect(result.rows[1].cells).toContain('+60.00');
	});
});
