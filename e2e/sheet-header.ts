import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Shared assertion for the fixed-header law: *in a sheet, the primary action never scrolls, and by
 * the same reasoning the way back never scrolls either.*
 *
 * Lives in a helper module rather than in one of the two specs that use it because the sheets it
 * covers sit on two different pages whose fixtures are seeded at different points of the run. Trying
 * to assert them all from one file meant seeding the bills fixture early, which pushed the first
 * page of /transactions along and failed six tests in `taplink-avatar.spec.ts` — the shared-dataset
 * ordering hazard `playwright.config.ts` documents, met head-on. So each page asserts its own sheets
 * where its own fixture already exists, through this one helper.
 */

/**
 * Reads the open sheet's structure off the live DOM. Located by ROLE plus the `lg:hidden` wrapper
 * only BottomSheet renders — never by a class list, which is the thing under test.
 */
const READ_SHEET = `(() => {
	const panels = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
		.filter((el) => (el.parentElement?.className ?? '').includes('lg:hidden'));
	if (panels.length === 0) return { error: 'no open sheet' };
	// A sub-sheet leaves its parent mounted; the last in DOM order is the one painted on top.
	const panel = panels[panels.length - 1];
	const kids = Array.from(panel.children);
	const handle = kids.find((el) => el.getAttribute('role') === 'separator') ?? null;
	const headerBand = kids.find((el) => el !== handle && el.className.includes('border-b')) ?? null;
	const body = panel.querySelector('.overflow-y-auto');
	return {
		hasHeaderBand: Boolean(headerBand),
		headerText: headerBand ? headerBand.textContent.trim() : '',
		headerOutsideBody: Boolean(headerBand && body && !body.contains(headerBand)),
		headerAboveBody: Boolean(
			headerBand && body &&
			headerBand.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1
		)
	};
})()`;

export async function expectFixedHeader(page: Page, expectedText: RegExp) {
	const sheet = await page.evaluate(READ_SHEET);
	expect(sheet).toMatchObject({
		hasHeaderBand: true,
		headerOutsideBody: true,
		headerAboveBody: true
	});
	// Non-empty, and actually the sheet's own title — an empty snippet satisfies the required
	// `header` prop and is precisely the hole this assertion exists to close.
	expect((sheet as { headerText: string }).headerText).toMatch(expectedText);
}
