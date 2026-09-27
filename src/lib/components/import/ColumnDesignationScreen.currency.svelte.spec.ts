import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * #600, SECOND CONTRADICTION PASS F3: the designation screen after the `/import/columns` currency
 * refusal.
 *
 * The refusal keeps the designation and reads « Choisissez un compte en EUR ». The screen mounted
 * the account panel WITHOUT the declared currency, so a user whose accounts are all in USD saw that
 * sentence over options with no currency on any line: the lead is drawn when the destinations hold
 * more than one currency OR a declared currency is passed (`AccountPicker`'s rule, same as
 * `/import`), and here neither was true. Separates « the screen passes the currency the refusal
 * named » from « it reopens the panel as if nothing had been refused ».
 */

const HEADERS = ['Date operation', 'Libelle', 'Montant', 'Devise'];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`]),
	rowCount: 2,
	detectedHeaderRow: true
};

const COMPLETE: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

const ALL_USD = [
	{
		id: 'usd-1',
		name: 'Checking USD',
		discriminant: '4417',
		transactionCount: 18,
		currency: 'USD'
	},
	{ id: 'usd-2', name: 'Savings USD', discriminant: '9032', transactionCount: 3, currency: 'USD' }
];

beforeEach(async () => {
	await page.viewport(1280, 800);
});

describe('the designation screen after the currency refusal', () => {
	it('says each account’s currency when the refusal named one', async () => {
		expect.assertions(1);
		await render(ColumnDesignationScreen, {
			file: FILE,
			initialAssignment: COMPLETE,
			accounts: ALL_USD,
			initialAccountId: 'usd-1',
			announceDelayMs: 0,
			declaredCurrency: 'EUR'
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
