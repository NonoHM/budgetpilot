import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT } from '$lib/domain/columnDesignation';

/**
 * The file meta line, at BOTH breakpoints, in ONE test per count.
 *
 * The seam this file exists for: the screen prints « n colonnes · n lignes · en-têtes détectés »
 * twice, once in the 390 file block and once in the 1280 heading, and no test ever put the two in
 * one measurement. Two ternaries would be two places that can be right about their own version of
 * the plural, and the divergence would be invisible to a spec that only mounts one layout: exactly
 * the class `AGENTS.md` records under "every level correct, the assembly not".
 *
 * `fileMetaLine` itself is asserted in `columnDesignationBanner.spec.ts`, at n = 1, n = 2 and with
 * the two counts disagreeing. What is only observable HERE is that both layouts call it.
 *
 * A one-column file puts the screen in `tooFewColumns`. That is deliberate and unavoidable: one
 * column IS the boundary value, and the file block renders in every state.
 */
const SINGULAR = '1 colonne · 1 ligne · en-têtes détectés';
const PLURAL = '2 colonnes · 2 lignes · en-têtes détectés';

function fileWith(columns: number, rows: number) {
	const headers = Array.from({ length: columns }, (_, index) => `Colonne ${index + 1}`);
	return {
		name: 'releve.csv',
		headers,
		samples: headers.map((_, index) => [`v${index}a`]),
		rowCount: rows,
		detectedHeaderRow: true
	};
}

function textAt(wide: boolean, columns: number, rows: number): string {
	const { container } = render(ColumnDesignationScreen, {
		file: fileWith(columns, rows),
		initialAssignment: EMPTY_ASSIGNMENT,
		wide
	});
	return container.textContent ?? '';
}

describe('the file meta line reads the same at 390 and at 1280', () => {
	it('is singular in both layouts at one column and one row', () => {
		// Asserted positively on the whole composed sentence in each layout, so a layout that lost
		// the line altogether fails here rather than passing an equality between two absences.
		expect(textAt(false, 1, 1)).toContain(SINGULAR);
		expect(textAt(true, 1, 1)).toContain(SINGULAR);
	});

	it('is unchanged from what shipped in both layouts at two columns and two rows', () => {
		expect(textAt(false, 2, 2)).toContain(PLURAL);
		expect(textAt(true, 2, 2)).toContain(PLURAL);
	});
});
