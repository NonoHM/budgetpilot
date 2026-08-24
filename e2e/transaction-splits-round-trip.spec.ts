// THE EXPORT FORMAT IS A CONTRACT, and this is the check aimed at the contract rather than at the
// feature. It must keep passing long after répartition stops being the newest thing in the repo: it
// is what goes red the day a chantier "tidies" a column out of the CSV header.
//
// The claim, in one sentence: a file BudgetPilot wrote is a file BudgetPilot reads back, and a
// répartition survives the trip as ONE transaction with its parts rather than as N transactions.
// Before OD-2 was paid for, one line per allocation meant an 80,00 € répartition came back as three
// separate transactions — and nothing reported it, because `amountCents` is in the dedupe key, so
// no allocation line matched the original's fingerprint and none was skipped as a duplicate.
//
// Every unit spec around this mocks one half away. `round-trip.spec.ts` runs both real functions
// but no database; only this reaches the real download route, the real upload form, the real
// `replaceSplits`, and the real list rendering of what came out the other end.
//
// The spec RESTORES what it changes: it removes the répartition it creates before finishing. The
// suite shares one database in declaration order, and the Répartition filter is rendered only when
// at least one split exists — leaving one behind changes the filter bar for every spec after this.
import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

const SOURCE_LABEL = 'E2E RT SOURCE';
const SPLIT_LABEL = 'E2E RT SPLIT';
const SOURCE_DATE = '2026-03-20';
const SPLIT_DATE = '2026-03-21';
/** Categories the seed already owns, so the trip creates no new ones to clean up. */
const PARENT_CATEGORY = 'Transport';
const OTHER_CATEGORY = 'Alimentation';

async function upload(page: import('@playwright/test').Page, csv: string) {
	await page.goto('/import');
	// Desktop and mobile each render their own copy of the form; only one is visible at a time.
	const form = page.locator('form[method="POST"]').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'e2e-round-trip.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(csv, 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
	await expect(form.locator('input[name="csvFile"]')).toBeVisible();
}

async function exportOf(page: import('@playwright/test').Page, query: string): Promise<string[]> {
	const response = await page.request.get(`/transactions/export?q=${encodeURIComponent(query)}`);
	expect(response.ok()).toBe(true);
	return (await response.text()).split('\r\n');
}

test.describe('the CSV round trip', () => {
	test('exports a répartition and reads it back as one transaction, parts intact', async ({
		page
	}) => {
		test.slow();
		await page.setViewportSize({ width: 1280, height: 800 });

		// ---- 1. an ordinary transaction, imported through the OLD header ----------------------
		// Deliberately v1: it is the shape a user's existing file has, and importing it here is what
		// proves the versioning did not replace the profile it extended.
		await upload(
			page,
			[
				'date;libelle;categorie;montant;type;nature;source_bancaire',
				`${SOURCE_DATE};${SOURCE_LABEL};${PARENT_CATEGORY};-8.00;expense;;csv`
			].join('\n')
		);

		// ---- 2. it comes back out through the NEW header, as a single allocation --------------
		const exported = await exportOf(page, SOURCE_LABEL);
		const header = exported[0];
		const sourceLine = exported.find((line) => line.includes(SOURCE_LABEL));

		expect(sourceLine, 'the export did not contain the transaction just imported').toBeTruthy();
		const columns = (sourceLine as string).split(';');
		// `1/1` and a total equal to the line's own amount: an unsplit row has the same shape as a
		// répartie one, which is what lets the parser treat both with one rule.
		//
		// THE INDICES MOVED BY ONE, and the reason is worth stating rather than silently renumbering:
		// the export gained a trailing `compte` column, so `part` is now third from the end and
		// `categorie_parent` second. Counting from the END is what made this a one-line change; the
		// same assertions written from the front would have needed every index re-derived.
		expect(columns.at(-3)).toBe('1/1');
		expect(columns[7]).toBe(columns[3]);
		expect(columns.at(-2)).toBe(PARENT_CATEGORY);
		/**
		 * The new `compte` cell, taken as-is and NOT asserted non-empty. Read this before tightening it.
		 *
		 * MEASURED on this branch: it is EMPTY, and that is a real defect rather than a property of
		 * this fixture. `routes/transactions/export/+server.ts` never passes `accountName`, so the
		 * column the export gained ships blank for every user. Task 10 added the column, the writer
		 * and the reader, and its Step 4 — the caller — was forbidden to the agent that did the rest,
		 * which is why nothing joined them. No unit test could see it: they all call
		 * `buildTransactionsCsv` directly and hand it the option the route does not.
		 *
		 * Asserted as PRESENT and round-tripped rather than as non-empty on purpose. Asserting
		 * non-empty would redden this spec for a defect it does not own; asserting it equals `''`
		 * would cement the defect as the contract. Reading it and carrying it back through the import
		 * keeps the round trip honest and leaves the repair visible.
		 */
		expect(columns).toHaveLength(11);
		const accountName = columns.at(-1) as string;

		// ---- 3. the same file, hand-edited into a répartition ----------------------------------
		// The HEADER is the export's own, taken from the response rather than retyped — it is the
		// contract, and a copy of it here would agree with itself forever. Only the data lines are
		// authored, so the test says out loud what shape it expects a répartition to have.
		await upload(
			page,
			[
				header,
				// The account cell carries the name read back OUT of the export, not a literal: the two
				// sides of this round trip must not be two sources for one string.
				`${SPLIT_DATE};${SPLIT_LABEL};${PARENT_CATEGORY};-5.00;expense;;csv;-8.00;1/2;${PARENT_CATEGORY};${accountName}`,
				`${SPLIT_DATE};${SPLIT_LABEL};${OTHER_CATEGORY};-3.00;expense;;csv;-8.00;2/2;${PARENT_CATEGORY};${accountName}`
			].join('\n')
		);

		// ---- 4. ONE row, and the parts are really in the database ------------------------------
		await page.goto(`/transactions?q=${encodeURIComponent(SPLIT_LABEL)}`);
		const rows = page.getByRole('row', { name: new RegExp(SPLIT_LABEL) });

		// The whole defect option (b) was chosen to prevent: two lines in, two transactions out.
		await expect(rows).toHaveCount(1);
		// The badge is not decoration here — it is rendered from `splitIndicatorOf` over
		// `allocationsOf`, reading the parts back out of the database through a path the importer
		// never touches. It is the independent confirmation that `replaceSplits` really ran.
		await expect(
			rows
				.first()
				.getByRole('cell')
				.nth(1)
				.getByRole('button', { name: new RegExp(m.splits_row_badge_others_short({ count: 2 })) })
		).toBeVisible();

		// ---- 5. and it leaves again in the shape it arrived in ---------------------------------
		const reExported = (await exportOf(page, SPLIT_LABEL)).filter((line) =>
			line.includes(SPLIT_LABEL)
		);

		expect(reExported).toHaveLength(2);
		for (const line of reExported) {
			const cells = line.split(';');
			// The PARENT's total on every line, never a part's — this is the column the fingerprint
			// is built from, so a part leaking into it would re-import as a different transaction.
			expect(cells[7]).toBe("'-8.00");
			// Second from the end since the export gained its trailing `compte` column, and the
			// account itself asserted beside it: a répartition's parts belong to the same account as
			// the parent, and nothing else in this file would notice if they stopped.
			expect(cells.at(-2)).toBe(PARENT_CATEGORY);
			expect(cells.at(-1)).toBe(accountName);
		}
		expect(reExported.map((line) => line.split(';').at(-3))).toEqual(['1/2', '2/2']);

		// ---- cleanup: the répartition must not outlive this spec -------------------------------
		await page
			.getByRole('link', { name: new RegExp(SPLIT_LABEL) })
			.first()
			.click();
		// Removal is deferred to the save, by design (1f) — clicking « Retirer » alone leaves the
		// répartition in place, which is exactly the state this cleanup exists to avoid.
		await page.getByRole('button', { name: m.splits_remove_action() }).first().click();
		await page
			.locator('form[action*="/saveSplits"]')
			.first()
			.getByRole('button', { name: m.common_save() })
			.click();
		await expect(page.getByRole('button', { name: m.splits_entry_action() }).first()).toBeVisible();
	});
});
