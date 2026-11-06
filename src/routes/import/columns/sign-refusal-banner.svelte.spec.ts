import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { setPendingDesignation } from '$lib/import/pendingDesignation.svelte';
import { clearPendingCollision } from '$lib/import/pendingCollision.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';

/**
 * #1207 C2c-S1, walk critique: after a refused Import, the banner and the sign step's own line both
 * said that no amount carries a minus sign, one above the other (AGENTS.md, question 4). The step
 * opens on `askAmountSign` and states the fact, so the banner stays quiet for that refusal.
 *
 * Separates « no banner when the step carries the fact » from « no banner at all »: the control
 * case renders the SAME sentence without `askAmountSign` and must find it, so a green first case
 * cannot come from a query that sees nothing.
 */
const VIEW = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['CB CARREFOUR'], ['24,90']],
	previewRows: [['24/06/2026', 'CB CARREFOUR', '24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'CB CARREFOUR', '24,90'],
	amountSignStates: ['none', 'none', 'unsigned'],
	rowCount: 1,
	detectedHeaderRow: true
} as unknown as DesignationFile;

const COMPLETE = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;
const SENTENCE = refusalLabel({ code: 'ambiguous-amount-sign', column: 2, sample: '24,90' });

function pend() {
	setPendingDesignation({
		file: new File(['Jour,Intitule,Somme\n'], 'releve.csv'),
		view: VIEW,
		initialAssignment: COMPLETE,
		dateOrder: null,
		currencyDeclined: false,
		account: null,
		correction: null
	} as never);
}

beforeEach(() => {
	clearPendingCollision();
	vi.clearAllMocks();
});

describe('the columns page after the sign refusal', () => {
	it('leaves the fact to the sign step instead of repeating it in a banner', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		pend();
		await render(Page, {
			form: { error: SENTENCE, keepDesignation: true, askAmountSign: 2 } as never
		});
		await expect.element(page.getByText(SENTENCE)).not.toBeInTheDocument();
	});

	it('still shows the same sentence when no step carries it (control)', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		pend();
		await render(Page, { form: { error: SENTENCE, keepDesignation: true } as never });
		await expect.element(page.getByText(SENTENCE)).toBeInTheDocument();
	});
});
