import { describe, expect, it } from 'vitest';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { parseCsvTransactions } from '../csv';

const MAISON_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

function parseMaisonLine(line: string) {
	return parseCsvTransactions(`${MAISON_HEADER}\n${line}`);
}

describe('profil maison', () => {
	it('détecte automatiquement le profil maison via son en-tête exact', () => {
		expect.assertions(2);

		const result = parseMaisonLine(
			'2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv'
		);

		expect(result.summary.profile).toBe('maison');
		expect(result.errors).toEqual([]);
	});

	it('importe une ligne maison valide complète (round-trip)', () => {
		expect.assertions(6);

		const result = parseMaisonLine(
			'2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;compte_courant'
		);
		const transaction = result.transactions[0];

		expect(transaction.date).toBe('2026-06-01');
		expect(transaction.label).toBe('Courses Auchan');
		expect(transaction.category).toBe('Alimentation');
		expect(transaction.amountCents).toBe(-4_210);
		expect(transaction.metadata.type).toBe('expense');
		expect(transaction.metadata.natureManual).toBe('spending');
	});

	it('importe un revenu maison avec montant positif', () => {
		expect.assertions(3);

		const result = parseMaisonLine('2026-06-05;Salaire;Revenus;1500.00;income;income;csv');
		const transaction = result.transactions[0];

		expect(transaction.amountCents).toBe(150_000);
		expect(transaction.metadata.type).toBe('income');
		expect(transaction.metadata.natureManual).toBe('income');
	});

	it('cellule nature vide → natureManual absent (null côté domaine)', () => {
		expect.assertions(2);

		const result = parseMaisonLine('2026-06-10;Loyer;Logement;-800;expense;;csv');

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].metadata.natureManual).toBeUndefined();
	});

	it('rejette une nature invalide', () => {
		expect.assertions(3);

		const result = parseMaisonLine('2026-06-01;X;Autre;10;income;bogus;csv');

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({ reason: 'nature invalide', field: 'nature' });
		expect(result.summary.invalidRows).toBe(1);
	});

	it('rejette une incohérence type=income / montant négatif', () => {
		expect.assertions(2);

		const result = parseMaisonLine('2026-06-01;X;Autre;-10;income;;csv');

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({
			reason: 'type et signe du montant incohérents',
			field: 'type'
		});
	});

	it('rejette une incohérence type=expense / montant positif', () => {
		expect.assertions(2);

		const result = parseMaisonLine('2026-06-01;X;Autre;10;expense;;csv');

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({
			reason: 'type et signe du montant incohérents',
			field: 'type'
		});
	});

	it('rejette un montant à zéro avant même de comparer le signe au type', () => {
		expect.assertions(2);

		// derivedType would be 'income' for a zero amount (amountCents >= 0): by declaring
		// type=expense here, we check that the zero-amount validation kicks in before the
		// sign comparison (otherwise the reason would be 'type and amount sign mismatch').
		const result = parseMaisonLine('2026-06-01;X;Autre;0;expense;;csv');

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({
			reason: 'montant à zéro refusé',
			field: 'amount'
		});
	});

	/**
	 * The sentinel used to be REFUSED here, and that refusal broke the one claim this profile
	 * exists to keep: `docs/getting-started.md` says a BudgetPilot export re-imports cleanly, and
	 * the export writes `getEffectiveCategory`, which is the literal sentinel for every row in the
	 * « à classer » pile. So exporting an uncategorized transaction and re-importing it reported
	 * « catégorie réservée refusée » and dropped the row — measured, not inferred, before the fix.
	 *
	 * Accepting it costs nothing that the refusal was buying: an EMPTY cell already resolves to the
	 * same sentinel two lines below, so a third-party file could always reach this bucket anyway.
	 */
	it('accepte la sentinelle « uncategorized » telle que l’export l’écrit, plutôt que de la refuser', () => {
		expect.assertions(2);

		const result = parseMaisonLine('2026-06-01;X;uncategorized;-10;expense;;csv');

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('cellule catégorie vide résout silencieusement vers le sentinel « Non catégorisé »', () => {
		expect.assertions(2);

		const result = parseMaisonLine('2026-06-01;X;;-10;expense;;csv');

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('source_bancaire est lu sans influencer transaction.source ni bloquer la ligne', () => {
		expect.assertions(4);

		const garbage = parseMaisonLine('2026-06-01;X;Autre;-10;expense;;compte-inconnu-garbage');
		const empty = parseMaisonLine('2026-06-01;X;Autre;-10;expense;;');

		expect(garbage.transactions).toHaveLength(1);
		expect(garbage.transactions[0].source).toBe('csv');
		expect(empty.transactions).toHaveLength(1);
		expect(empty.transactions[0].source).toBe('csv');
	});

	it('neutralise un libellé au format injection de formule', () => {
		expect.assertions(1);

		const result = parseMaisonLine('2026-06-01;=SUM(A1:A9);Autre;-10;expense;;csv');

		expect(result.transactions[0].label).toBe("'=SUM(A1:A9)");
	});

	it('détecte un doublon intra-fichier (même date+montant+libellé)', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			`${MAISON_HEADER}\n` +
				'2026-06-01;Courses;Alimentation;-10;expense;;csv\n' +
				'2026-06-01;Courses;Alimentation;-10;expense;;csv'
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.errors).toContain('Ligne 3: doublon détecté');
		expect(result.summary.duplicateRows).toBe(1);
	});
});
