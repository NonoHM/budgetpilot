import { describe, expect, it } from 'vitest';
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
