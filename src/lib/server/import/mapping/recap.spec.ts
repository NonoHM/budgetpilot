import { describe, expect, it } from 'vitest';
import type { UntrustedColumnMapping } from './model';
import { designationAssignment, recapDesignation } from './recap';

/**
 * What a memorised correspondance looks like when the file that made it is long gone.
 *
 * The designation screen was built to be opened by an upload, so everything it draws comes from a
 * `DesignationFile`. The recap is reached from `/imports` instead, months later, with no file in
 * hand: this module is the adapter, and its whole job is to produce a view that is TRUE about the
 * mapping rather than one that merely renders.
 *
 * The two halves are tested separately because they fail differently. `recapDesignation` lying
 * shows the user a column they did not designate; `designationAssignment` lying re-opens the
 * correction screen with the wrong rows already filled, which is worse than opening it empty.
 */
const NAMED: UntrustedColumnMapping = {
	matchBy: 'name',
	dateColumn: 'Champ A',
	labelColumn: 'Champ C',
	amountColumn: 'Champ D',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 4
};

describe('the recap of a mapping remembered by name', () => {
	it('draws one row per designated role, in role order, carrying the column the user named', () => {
		const view = recapDesignation(NAMED, {
			fileName: 'releve.csv',
			rowCount: 5,
			sample: { date: '04/03/2019', label: 'RF00005', amount: '-24,90' }
		});

		expect(view.file.headers).toStrictEqual(['Champ A', 'Champ C', 'Champ D', '']);
		expect(view.assignment).toStrictEqual({ date: 0, label: 1, amount: 2, category: null });
		expect(view.file.hasHeaderRow).toBe(true);
	});

	it('pads to the file’s real width, because the screen prints “{columns} colonnes” from it', () => {
		// A three-role array would tell the user their four-column statement had three columns, on
		// the one screen they opened to check what had been read. The padding is never shown: the
		// recap draws no column cards, only the four role rows.
		const view = recapDesignation({ ...NAMED, columnCount: 13 }, base());

		expect(view.file.headers).toHaveLength(13);
		expect(view.file.headers.slice(0, 3)).toStrictEqual(['Champ A', 'Champ C', 'Champ D']);
	});

	it('shows the value that LANDED, which is the only evidence a wrong column leaves behind', () => {
		// The whole reason this screen is reachable. A correspondance that named the reference
		// column as the label imports every row without a single invalid one: nothing is flagged,
		// and the only thing that says so is the value beside the role.
		const view = recapDesignation(NAMED, {
			fileName: 'releve.csv',
			rowCount: 5,
			sample: { date: '04/03/2019', label: 'RF00005', amount: '-24,90' }
		});

		expect(view.file.firstRow).toStrictEqual(['04/03/2019', 'RF00005', '-24,90', '']);
	});

	it('draws a role with no value rather than dropping the row', () => {
		// An import batch whose transactions were all deleted leaves the mapping without a sample.
		// A row that vanishes would say the role was never designated, which is a different fact.
		const view = recapDesignation(NAMED, { fileName: 'releve.csv', rowCount: 5, sample: {} });

		expect(view.file.headers).toStrictEqual(['Champ A', 'Champ C', 'Champ D', '']);
		expect(view.file.firstRow).toStrictEqual(['', '', '', '']);
	});

	it('includes the category row when one was designated, and only then', () => {
		const withCategory = { ...NAMED, categoryColumn: 'Champ B' };

		expect(recapDesignation(withCategory, base()).assignment).toStrictEqual({
			date: 0,
			label: 1,
			amount: 2,
			category: 3
		});
		expect(recapDesignation(NAMED, base()).assignment.category).toBeNull();
	});
});

describe('the recap of a mapping remembered by position', () => {
	const POSITIONAL: UntrustedColumnMapping = {
		matchBy: 'position',
		dateColumn: null,
		labelColumn: null,
		amountColumn: null,
		categoryColumn: null,
		dateIndex: 0,
		labelIndex: 3,
		amountIndex: 5,
		categoryIndex: null,
		columnCount: 6
	};

	it('keeps the real positions rather than compacting them, because position IS the mapping', () => {
		// Compacting would draw `Colonne 1 · Colonne 2 · Colonne 3` for a mapping that actually
		// points at 1, 4 and 6. The plate makes a positional correspondance say so precisely
		// because a reordered export silently puts amounts in the date column, and a recap that
		// renamed the positions would remove the one check the user has.
		const view = recapDesignation(POSITIONAL, {
			fileName: 'releve.csv',
			rowCount: 5,
			sample: { date: '04/03/2019', label: 'RF00005', amount: '-24,90' }
		});

		expect(view.file.headers).toHaveLength(6);
		expect(view.assignment).toStrictEqual({ date: 0, label: 3, amount: 5, category: null });
		expect(view.file.firstRow?.[0]).toBe('04/03/2019');
		expect(view.file.firstRow?.[3]).toBe('RF00005');
		expect(view.file.firstRow?.[5]).toBe('-24,90');
	});

	it('says the file had no readable headers, so the rows are named by position', () => {
		expect(recapDesignation(POSITIONAL, base()).file.hasHeaderRow).toBe(false);
	});
});

describe('re-opening the correction screen over a real file', () => {
	it('resolves the remembered names to THIS file’s indices, folding as the fingerprint does', () => {
		// « État 2, désignations intactes ». The user came here to change one row, so the other
		// three have to arrive already designated or the correction is a re-designation.
		const assignment = designationAssignment(NAMED, [
			'  CHAMP A ',
			'Champ B',
			'champ c',
			'Champ D'
		]);

		expect(assignment).toStrictEqual({ date: 0, label: 2, amount: 3, category: null });
	});

	it('leaves a role empty when its column is gone rather than guessing a neighbour', () => {
		// State 3b arriving through the correction path. An index picked by proximity would put the
		// user's money column somewhere plausible and silent, which is the failure this whole
		// chantier exists to remove.
		const assignment = designationAssignment(NAMED, ['Champ A', 'Champ B', 'Champ D']);

		expect(assignment).toStrictEqual({ date: 0, label: null, amount: 2, category: null });
	});

	it('reads a positional mapping from its indices, and refuses one that points past the file', () => {
		const positional: UntrustedColumnMapping = {
			...NAMED,
			matchBy: 'position',
			dateColumn: null,
			labelColumn: null,
			amountColumn: null,
			dateIndex: 0,
			labelIndex: 1,
			amountIndex: 9
		};

		expect(designationAssignment(positional, ['a', 'b', 'c'])).toStrictEqual({
			date: 0,
			label: 1,
			amount: null,
			category: null
		});
	});

	it('resolves nothing from a mapping whose matchBy is neither name nor position', () => {
		// Reachable through a restored backup. `applyColumnMapping` refuses such a row rather than
		// falling through to the name branch, and this must agree with it: a stored record must not
		// choose its own matching mode by being malformed.
		const malformed = { ...NAMED, matchBy: 'nom' } as unknown as UntrustedColumnMapping;

		expect(designationAssignment(malformed, ['Champ A'])).toStrictEqual({
			date: null,
			label: null,
			amount: null,
			category: null
		});
	});
});

function base() {
	return { fileName: 'releve.csv', rowCount: 5, sample: {} };
}
