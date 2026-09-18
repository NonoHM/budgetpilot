import { type Page } from '@playwright/test';
import * as m from '../src/lib/paraglide/messages';

/**
 * Answers the date reading question when the file leaves it open, and does nothing when it does not.
 *
 * ## Why a designation journey needs this now
 *
 * Designating a date column whose every value sits at or below 12 in both positions DEFERS the
 * sheet's close by exactly one question: the column is applied, and the same surface asks how the
 * dates read instead of closing. So a spec that designates such a column and then clicks the next
 * row clicks into an open sheet.
 *
 * It does not fail where the cause is. The backdrop swallows the click, Playwright waits the full
 * timeout, and the error names `<div role="presentation" class="absolute inset-0 bg-zinc-950/45">`
 * or the step 2 subline, neither of which mentions dates. That is exactly how five specs failed the
 * first time this shipped, across four files, and it reads as a hang rather than as a question
 * nobody answered.
 *
 * Same reasoning as `chooseStatementAccount` next door, and the same failure shape: a choice the
 * screen now requires, missing from journeys written before it existed.
 *
 * ## CONDITIONAL, and that is load bearing rather than defensive
 *
 * Most fixtures in this suite carry a date above 12 somewhere in the column, which PROVES the order
 * and is never asked about. A helper that waited for the question would time out on every one of
 * them, turning a correct file into a failing spec. So this asks whether the question is on screen
 * and returns false when it is not, which also makes it safe to call after every designation rather
 * than only after the ones known to need it: the day a fixture's dates change, the journey does not
 * break.
 *
 * ## It ANSWERS rather than dismissing
 *
 * Dismissing leaves the row reading « Confirmer », which is a screen mid-question, and every caller
 * here is a journey that goes on to import. Day-first is chosen because it is what these fixtures
 * mean and what the parser would have applied anyway, so no spec's expected dates move: this helper
 * makes the journey complete without changing what it imports.
 *
 * @returns Whether the question was there to answer, so a caller that wants to assert the state it
 *   is in can, rather than having to re-derive it.
 */
export async function answerDateReadingIfAsked(page: Page): Promise<boolean> {
	const dayFirst = page.getByRole('option', {
		name: new RegExp(`^${m.import_datesheet_option_day_first()}`)
	});
	if ((await dayFirst.count()) === 0) return false;
	await dayFirst.first().click();
	// The sheet closes on the choice and focus returns to the Date row. Waited for rather than slept
	// through: the close is the precondition for whatever the caller clicks next, and a sleep here
	// would report the next click's failure instead of this one's.
	await page.getByText(m.import_datesheet_title()).waitFor({ state: 'hidden', timeout: 5000 });
	return true;
}
