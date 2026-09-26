import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import * as m from '$lib/paraglide/messages';
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
 * #600, SECOND CONTRADICTION PASS F3, on the route's side: after the `/import/columns` currency
 * refusal, the page hands the screen the currency the refusal named, so the account panel of a
 * user whose accounts are all in USD says so on every line under « Choisissez un compte en EUR ».
 * Separates « the page passes the refusal's declared currency to the screen » from « it drops it
 * between the action's reply and the screen ». `ColumnDesignationScreen.currency.svelte.spec.ts`
 * covers the screen's own half.
 */
const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme', 'Devise'],
	samples: [['2026-06-24'], ['MERCERIE'], ['-24,90'], ['EUR']],
	previewRows: [['2026-06-24', 'MERCERIE', '-24,90', 'EUR']],
	coverage: [1, 1, 1, 1],
	firstRow: ['2026-06-24', 'MERCERIE', '-24,90', 'EUR'],
	rowCount: 1,
	detectedHeaderRow: true
} as DesignationFile;

const COMPLETE = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

beforeEach(() => {
	clearPendingCollision();
	vi.clearAllMocks();
});

describe('the columns page after the currency refusal', () => {
	it('passes the declared currency to the account panel', async () => {
		expect.assertions(1);
		await page.viewport(1280, 800);
		setPendingDesignation({
			file: new File(['Jour,Intitule,Somme,Devise\n'], 'releve.csv'),
			view: VIEW,
			initialAssignment: COMPLETE,
			candidates: {},
			dateOrder: null,
			account: {
				options: [
					{
						id: 'usd-1',
						name: 'Checking USD',
						discriminant: '4417',
						transactionCount: 18,
						currency: 'USD'
					},
					{
						id: 'usd-2',
						name: 'Savings USD',
						discriminant: '9032',
						transactionCount: 3,
						currency: 'USD'
					}
				],
				resolution: { rank: 3 as const, kind: 'orphan' as const },
				memory: null,
				prefillName: '',
				chosenId: 'usd-1'
			},
			correction: null
		} as never);
		await render(Page, {
			form: {
				error: refusalLabel({
					code: 'declared-currency-mismatch',
					declared: 'EUR',
					destination: 'USD'
				}),
				keepDesignation: true,
				declaredCurrency: 'EUR'
			} as never
		});
		await page.getByRole('button', { name: new RegExp(m.import_account_row_label()) }).click();
		await expect
			.element(
				page.getByRole('option', {
					name: `Savings USD, USD, ${m.import_account_option_detail_many({ fragment: '9032', count: 3 })}`
				})
			)
			.toBeInTheDocument();
	});
});
