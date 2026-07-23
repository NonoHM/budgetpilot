import { expect, test } from './fixtures';
import { SEEDED_TRANSACTION_LABELS } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the SearchBar extraction (wave 2, see CLAUDE.md): the pill-shaped search input on
// /rules and /transactions was pulled into a shared component with a new inline clear button.
// The critical constraint for /transactions is that the field stays a plain native <input>
// inside the real <form method="GET"> used for deep-linking (q/qMode=regex in the URL) — these
// tests drive the actual GET submission end-to-end rather than just asserting on markup, which
// is the one thing the migration brief explicitly calls out as must-not-regress.

test('transactions: submitting a regex search produces the same q/qMode URL as before the migration', async ({
	page
}) => {
	await page.goto('/transactions');

	const searchInput = page.getByRole('searchbox', { name: m.transactions_search_label() });
	await searchInput.fill('^CARREFOUR');

	await page.getByRole('button', { name: m.transactions_regex_toggle_aria() }).first().click();
	await page.getByRole('button', { name: m.transactions_submit_filter() }).first().click();

	await expect(page).toHaveURL(/[?&]q=%5ECARREFOUR(&|$)/);
	await expect(page).toHaveURL(/[?&]qMode=regex(&|$)/);

	// A reload (simulating browser back/forward) must redisplay the value from the URL, not lose
	// it — the uncontrolled `value` prop must keep winning over anything locally typed.
	await page.reload();
	await expect(searchInput).toHaveValue('^CARREFOUR');
	await expect(
		page.getByRole('button', { name: m.transactions_regex_toggle_aria() }).first()
	).toHaveAttribute('aria-pressed', 'true');
});

test('transactions: the clear button empties the field without submitting the form', async ({
	page
}) => {
	await page.goto(`/transactions?q=${encodeURIComponent(SEEDED_TRANSACTION_LABELS[0])}`);

	const searchInput = page.getByRole('searchbox', { name: m.transactions_search_label() });
	await expect(searchInput).toHaveValue(SEEDED_TRANSACTION_LABELS[0]);

	await page.getByRole('button', { name: m.common_search_clear_aria() }).first().click();

	await expect(searchInput).toHaveValue('');
	await expect(searchInput).toBeFocused();
	// Clearing is a local DOM-only action — the URL (and therefore the actual server-applied
	// filter) must not change until the user explicitly submits again.
	await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(SEEDED_TRANSACTION_LABELS[0])}`));
});

test('rules: typing filters the list client-side, and the clear button restores it — no navigation', async ({
	page
}) => {
	await page.goto('/rules');
	const urlBeforeTyping = page.url();

	// Desktop and mobile each render their own SearchBar instance + "no match" text (CSS-hidden,
	// not removed, at the inactive breakpoint) — both share `searchRules`, so scope to the first.
	const searchInput = page.getByRole('searchbox', { name: m.rules_search_label() }).first();
	await searchInput.fill('zzz-no-such-rule-zzz');

	await expect(page.getByText(m.rules_no_match()).first()).toBeVisible();
	expect(page.url()).toBe(urlBeforeTyping);

	await page.getByRole('button', { name: m.common_search_clear_aria() }).first().click();

	await expect(searchInput).toHaveValue('');
	await expect(page.getByText(m.rules_no_match()).first()).not.toBeVisible();
	expect(page.url()).toBe(urlBeforeTyping);
});
