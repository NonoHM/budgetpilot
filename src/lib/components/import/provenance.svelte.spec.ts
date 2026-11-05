import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';
import { provenanceText } from '$lib/i18n/provenanceText';

/**
 * #1207 C2b on the screen: each row holding a value that detection or memory produced says so, and
 * the line leaves the row the moment the member's choice replaces that value. Expected words come
 * from `provenanceText`, the one place a layer becomes text, never retyped.
 */
const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];
const DETECTED: RoleAssignment = { ...EMPTY_ASSIGNMENT, amount: 3 };
const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	rowCount: 12,
	detectedHeaderRow: true,
	proposals: {
		designated: DETECTED,
		candidates: { date: [], label: [], amount: [3], category: [], currency: [] }
	}
};

async function mount(props: Record<string, unknown> = {}) {
	return render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: DETECTED,
		accounts: [
			{ id: 'account-1', name: 'Compte courant', discriminant: '4417', transactionCount: 3 }
		],
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		...props
	});
}

const said = (p: Parameters<typeof provenanceText>[0]) => {
	const { label, reason } = provenanceText(p);
	return `${label}, ${reason}`;
};

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('the provenance line on the designation screen (#1207)', () => {
	// Separates « detection designated this column by its header » from « no line on the row ».
	it('describes a detected row by the header that matched', async () => {
		await mount();
		await expect
			.element(page.getByRole('button', { name: /^Montant,/ }))
			.toHaveAccessibleDescription(
				said({ layer: 'rule', reason: { code: 'header', header: 'Montant' } })
			);
	});

	// Separates « the value is still detection's » from « the member replaced it ».
	it('drops the line once the member chooses another column', async () => {
		await mount();
		await page.getByRole('button', { name: /^Montant,/ }).click();
		await page.getByRole('option', { name: /^Categorie\./ }).click();
		await expect
			.element(page.getByRole('button', { name: /^Montant,/ }))
			.toHaveAccessibleDescription('');
	});

	// Separates a remembered column kept as the member's own from one detection designated.
	it('describes a remembered row by what it was kept from', async () => {
		const remembered: RoleAssignment = {
			date: 0,
			label: 2,
			amount: 3,
			category: null,
			currency: null
		};
		await mount({
			file: { ...FILE, proposals: { ...FILE.proposals, designated: EMPTY_ASSIGNMENT } },
			initialAssignment: remembered,
			remembered: {
				assignment: remembered,
				layers: { date: 'rule', label: 'member', amount: null, category: null }
			}
		});
		await expect
			.element(page.getByRole('button', { name: /^Libellé,/ }))
			.toHaveAccessibleDescription(
				said({ layer: 'remembered', reason: { code: 'kept', from: 'member' } })
			);
		await expect
			.element(page.getByRole('button', { name: /^Montant,/ }))
			.toHaveAccessibleDescription(
				said({ layer: 'remembered', reason: { code: 'kept', from: 'unknown' } })
			);
	});
});
