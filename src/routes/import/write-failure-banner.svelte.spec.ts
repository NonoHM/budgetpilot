import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import ImportPage from './+page.svelte';
import ImportsPage from '../imports/+page.svelte';
import type { PageData as ImportData } from './$types';
import type { PageData as ImportsData } from '../imports/$types';

/**
 * D3, contradiction pass item 6: the sentence for a partial write names WHICH import to delete by
 * the timestamp `/imports` names it by (`CONTEXT.md`, « Import »: the only attribute that tells two
 * imports of one statement apart, #380). On the correction door the partial import and the original
 * share a file name, so the name would identify both.
 *
 * ## The two strings must be the same string
 *
 * The user reads a date in the banner and looks for it in the history. The test renders BOTH pages
 * from ONE `createdAt`, reads the date back out of the history's row (never recomputed here: a test
 * that formats its own expectation asserts the copy, not the page), and requires the banner to be
 * the catalogue sentence built around exactly that string. Separates « the banner formats with the
 * history's function » from « the banner formats a date »: a second formatter with a different
 * format, even one naming the same instant, turns it red.
 *
 * The instant has a non-zero second on purpose: a formatter to the minute agrees with the history
 * on every instant whose seconds read :00, and this one does not.
 */

const CREATED_AT = '2026-09-27T11:31:05.000Z';

const HISTORY = {
	cancelled: false,
	collisions: [],
	batches: [
		{
			id: 'batch-partial',
			fileName: 'releve.csv',
			source: 'FILE',
			profile: 'generic',
			rowCount: 60,
			importedRows: 39,
			duplicateRows: 0,
			invalidRows: 0,
			periodStart: '2026-09-01',
			periodEnd: '2026-09-26',
			createdAt: CREATED_AT,
			transactionCount: 39,
			columnMapping: null,
			accountName: null
		}
	]
} as unknown as ImportsData;

const IMPORT_DATA = { user: null, correction: null } as unknown as ImportData;
const PARTIAL = { writeFailure: { kind: 'partly-saved', landedRows: 39, createdAt: CREATED_AT } };

async function bannerText(): Promise<string> {
	const banner = await page.getByRole('alert').first().element();
	return (banner.textContent ?? '').trim().replace(/\s+/g, ' ');
}

/** Distinct line boxes of the banner's own text, the dismiss control excluded. */
async function bannerLines(): Promise<number> {
	const banner = await page.getByRole('alert').first().element();
	const tops = new Set<number>();
	const walker = document.createTreeWalker(banner, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.textContent?.trim() || node.parentElement?.closest('button')) continue;
		const range = document.createRange();
		range.selectNodeContents(node);
		for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top));
	}
	return tops.size;
}

describe('the partial-write banner names the import as the history does', () => {
	it('shows the date the history row shows, to the character', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);
		const history = await render(ImportsPage, { data: HISTORY, form: null });
		const rowDate = (
			(await page.getByTitle(CREATED_AT).first().element()).textContent ?? ''
		).trim();
		history.unmount();

		await render(ImportPage, { data: IMPORT_DATA, form: PARTIAL as never });

		// CALIBRATION: the row rendered a date, to the second.
		expect(rowDate).toMatch(/\d{1,2}:\d{2}:\d{2}/);
		expect(await bannerText()).toBe(
			m.import_error_write_partly_saved_many({ count: 39, date: rowDate })
		);
	});
});

describe('the partial-write banner stays within three lines at 390 px', () => {
	/**
	 * AGENTS.md, « Writing a sentence for the interface »: a string wrapping to four lines on a phone
	 * is skipped. Measured with the longest French month and a time to the second, which is the
	 * widest date this sentence carries.
	 */
	it('reads in at most three lines with a September date', async () => {
		expect.assertions(1);
		await page.viewport(390, 844);
		await render(ImportPage, { data: IMPORT_DATA, form: PARTIAL as never });

		expect(await bannerLines()).toBeLessThanOrEqual(3);
	});

	it('CALIBRATION: the counter reads four lines for a wording the measurement rejected', async () => {
		// A line counter that always answered 1 would pass the test above. This puts the wording
		// the measurement measured at four lines into the same banner, at the same width.
		expect.assertions(1);
		await page.viewport(390, 844);
		await render(ImportPage, { data: IMPORT_DATA, form: PARTIAL as never });
		const banner = await page.getByRole('alert').first().element();
		const text = [...banner.querySelectorAll('*')].find(
			(el) => el.children.length === 0 && (el.textContent ?? '').includes('Imports')
		) as HTMLElement;
		const date = (text.textContent ?? '').replace(/^Import du /, '').replace(/ arrêté.*$/, '');
		text.textContent = `L'import du ${date} s'est arrêté après 39 transactions enregistrées. Supprimez-le dans Imports.`;

		expect(await bannerLines()).toBe(4);
	});
});
