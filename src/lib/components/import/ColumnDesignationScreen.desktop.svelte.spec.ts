import { page } from 'vitest/browser';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * 1280x800, and the figures include every border. Do not round 1230 up to 1232.
 *
 * BREAK MATRIX, read per test, run 2026-08-15.
 *
 * 1. Frame `px-6` to `px-4`: **one red, reading 1246 against 1230.** Predicted two and it is one:
 *    the command column's left edge is not asserted anywhere, only its width, which is correct
 *    since the width is the figure the plate pins. The frame's own 1280 stays green, rightly, the
 *    frame is not what moved.
 * 2. `w-[400px]` to `w-[380px]` on the command column: **one red at 380 against 400.** The content
 *    width stays green, which is the point of asserting both: a column that shrinks inside a
 *    correct content box is exactly the failure a single outer measurement cannot see.
 * 3. `compact={wide}` to `compact={false}` on the rows: **one red at 68 against 56.** Predicted two.
 *    It is one because the row height and the card height are asserted in the SAME test and the run
 *    stops at the first, so the card's 307 is not independently observed under this break. It is
 *    observed under a padding change, which is a different break and not one run here.
 *
 * Two of those three predictions were wrong before the runs. Recorded rather than corrected
 * silently: predicting a break's result is the same habit as choosing a fixture for how it reads.
 *
 * BREAK MATRIX for Planche 5b, run 2026-08-19, on the three recap assertions below.
 *
 * 4. `{#if !recap}` to `{#if true}` on the preview slot: **two red**, the slot assertion and the
 *    centring one. The second is not a leak: with a second child in the row, `justify-center`
 *    centres the PAIR, so the column's gutters stop being equal. The slot and the centring are one
 *    layout decision and the matrix is what shows it.
 * 5. `w-[560px]` back to `w-[400px]` in recap: **one red**, the 560 assertion alone.
 * 6. `justify-center` dropped: **one red**, the centring assertion alone.
 * 7. The slot condition INVERTED, so the control form loses its preview: **seven red**, including
 *    all three pre-existing preview tests. That is the assertion that the condition sits on the
 *    right branch, paid by the tests that were already here.
 *
 * A HARNESS FINDING, worth more than the matrix. Runs 4 and 7 were first written against the bare
 * string `{#if !recap}`, which occurs THREE times in the component, and `String.replace` rewrites
 * the first. Both patches silently broke the condition banner instead and reddened two sticky-box
 * tests, which reads like a real result about the preview slot and is a result about something
 * else. **A break patch must assert its target is UNIQUE, not merely present**: asserting presence
 * catches a stale patch and cannot catch a misaimed one.
 */
const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];

const FILE = {
	name: 'releve-juin-2026.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	rowCount: 132,
	hasHeaderRow: true
};

const COMPLETE: RoleAssignment = { date: 0, label: 2, amount: 3, category: 4 };

function mount(props: Record<string, unknown> = {}) {
	const { container } = render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		wide: true,
		...props
	});
	container.style.width = '1280px';
	container.style.height = '800px';
	const pick = (testid: string) =>
		container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
	return {
		container,
		frame: pick('designation-frame'),
		content: pick('designation-content'),
		command: pick('designation-command'),
		card: pick('designation-card'),
		foot: pick('designation-command-foot'),
		previewSlot: pick('designation-preview-slot')
	};
}

describe('the frame is 1280 and the content is 1230, and the frame is asserted for its own sake', () => {
	it('renders the frame at its full 1280 rather than at whatever the window allowed', () => {
		// The plate records a desktop frame capped to its window rendering 802 px while the document
		// claimed six visible columns against 2.2 actually visible. Every figure below was computed
		// against 1280, so a compressed frame makes all of them wrong at once and none of them
		// obviously wrong. This is the one assertion that can see it.
		const { frame } = mount();

		expect(frame.getBoundingClientRect().width).toBe(1280);
	});

	it('leaves 1230 of content: 1280 minus the frame border minus 2x24', () => {
		// The figures include every border. 1232 is what you get by forgetting the 1 px each side,
		// which is the same arithmetic slip the banner's 64 records.
		const { content } = mount();

		expect(content.getBoundingClientRect().width).toBe(1230);
	});
});

describe('the command column', () => {
	it('is 400 wide, asserted separately from the content box that holds it', () => {
		// A column that shrinks inside a correct content box is exactly the failure an outer
		// measurement cannot see, so both are pinned. It is also why the two are separate tests:
		// one figure moving tells you which.
		const { command } = mount();

		expect(command.getBoundingClientRect().width).toBe(400);
	});

	it('draws 56 px rows and a 307 px card, which is the mobile card with desktop rows', () => {
		// 14 padding + 16 label + 10 gap + 4x56 + 2 hairlines + 25 separator block + 14 padding + 2
		// border. Row 56 at 1280 and 68 at 390, never the reverse, and both absolute: a test
		// asserting only that they differ passes in a world where both are zero.
		const { card, container } = mount({ initialAssignment: COMPLETE });

		const rows = container.querySelectorAll('button[aria-haspopup="listbox"]');
		expect(rows.length).toBe(4);
		for (const row of rows) {
			expect(row.getBoundingClientRect().height).toBe(56);
		}
		expect(card.getBoundingClientRect().height).toBe(307);
	});

	it('rounds the card at 8 rather than 24, which is the referential desktop card', () => {
		// Rule 5 gives 24 to a mobile page card and 8 to a desktop one. Asserted as a real computed
		// radius rather than a class name, and against the mobile value, so the two states are
		// distinguished rather than one being confirmed.
		const wide = mount();
		expect(getComputedStyle(wide.card).borderTopLeftRadius).toBe('8px');
		wide.container.remove();

		const narrow = mount({ wide: false });
		expect(getComputedStyle(narrow.card).borderTopLeftRadius).toBe('24px');
	});
});

describe('the banner and the actions are one box, and the box is what sticks', () => {
	it('holds both in a single element', () => {
		// What COMMANDS the primary action travels with it. If the banner and the actions were two
		// boxes, the count explaining why the primary is off could be scrolled away from the primary
		// it explains, which is the defect the Repartition plate's amendment exists to prevent.
		const { foot } = mount();

		expect(foot.querySelector('[data-testid="condition-banner"]')).not.toBeNull();
		expect(foot.querySelector('button[aria-disabled="true"]')).not.toBeNull();
	});

	it('sticks by its own box rather than by the page', () => {
		const { foot } = mount();

		expect(getComputedStyle(foot).position).toBe('sticky');
	});

	it('points the blocked primary at the banner inside the same box', () => {
		// The `aria-describedby` target must be reachable from the button, and both are now in one
		// box: a dangling reference is silent and looks identical in markup to a working one, so the
		// lookup is performed rather than the attribute being read.
		const { foot } = mount();

		const primary = foot.querySelector('button[aria-disabled="true"]') as HTMLElement;
		const describedBy = primary.getAttribute('aria-describedby');
		expect(describedBy).toBe('column-designation-consequence');
		expect(foot.querySelector(`#${describedBy}`)).not.toBeNull();
	});
});

describe('Lacune B: the preview table is drawn, and only when there are real rows to draw', () => {
	/**
	 * This block used to assert the slot was EMPTY, and that was right while the argument was about
	 * the referential. It is now about what the file carries.
	 *
	 * The slot stayed empty in production for a measurable cost: at 1280 it was 806 px wide and
	 * 0 px tall, so the screen was a 400 px column with 855 px of blank beside it. The table is
	 * built locally and unregistered — #332 still owns the shared brique and this is its first
	 * consumer to absorb, never its source.
	 *
	 * What survives from the old assertion is the discipline: the slot must not draw a table it has
	 * no rows for. `samples` are chosen per column and would fabricate transactions, so a screen
	 * without `previewRows` draws nothing rather than drawing something plausible.
	 */
	it('reserves the room and renders no table when the file carries no preview rows', () => {
		const { previewSlot, container } = mount();

		expect(previewSlot).not.toBeNull();
		expect(previewSlot.children.length).toBe(0);
		expect(container.querySelectorAll('table').length).toBe(0);
	});

	/**
	 * Planche 5b, and the whole of it is that the slot is NOT DECLARED rather than corrected.
	 *
	 * `FilePreviewTable` is guarded on `previewRows` and `recapDesignation` builds none, because
	 * without a file there is nothing to preview (owner arbitrage 2). The component is right. What
	 * was wrong is upstream: the upload screen's grid declares a preview area that recap mode
	 * inherits and never fills, measured at 806 x 0, leaving 855 px of blank beside a four-row card.
	 *
	 * A `min-height` on that slot would reserve the emptiness ON PURPOSE, which is the repair this
	 * refuses. The column stops being the left half of something instead.
	 */
	it('declares no preview area at all in recap mode', () => {
		const { previewSlot, container } = mount({ initialAssignment: COMPLETE, readOnly: true });

		// The SLOT, not the table. A query for the table alone cannot separate "draws no preview"
		// from "draws an empty preview", and the second is the defect that shipped.
		expect(previewSlot).toBeNull();
		expect(container.querySelectorAll('table').length).toBe(0);
	});

	/**
	 * 560 is brique 15's tall-modal width, already a reading width of this product, so nothing new is
	 * introduced for a screen that has no new data to show. Asserted absolutely, like every other
	 * figure here.
	 */
	it('is a single 560 px column, centred, in recap mode', () => {
		const { command, content } = mount({ initialAssignment: COMPLETE, readOnly: true });

		expect(command.getBoundingClientRect().width).toBe(560);

		// Centred, and measured as equal gutters rather than by reading a class: `justify-center` on
		// a flex row with one child is what produces this, and a class assertion could not tell it
		// from `justify-start` on a column that happens to be wide.
		const left = command.getBoundingClientRect().left - content.getBoundingClientRect().left;
		const right = content.getBoundingClientRect().right - command.getBoundingClientRect().right;
		expect(Math.round(left)).toBe(Math.round(right));
	});

	/**
	 * THE SEAM THE SCREENSHOT FOUND AND NO FIGURE DID.
	 *
	 * Every geometry assertion in this file measures ONE box against the content box that holds it.
	 * None measured two siblings against each other, so with the preview area gone the card centred
	 * at 560 while the heading stayed pinned to the left gutter, and the screen named its content
	 * from an axis the content was not on. Green throughout, and obvious in the first screenshot.
	 *
	 * Asserted as EQUAL LEFT EDGES rather than as a class, because `mx-auto` on a fixed width is
	 * what produces it and a class assertion could not tell that from a margin that happens to look
	 * right at this one viewport.
	 */
	it('puts the heading on the same axis as the column it names, in recap mode', () => {
		const { command, container } = mount({ initialAssignment: COMPLETE, readOnly: true });
		const heading = container.querySelector('[data-testid="designation-heading"]') as HTMLElement;

		expect(Math.round(heading.getBoundingClientRect().left)).toBe(
			Math.round(command.getBoundingClientRect().left)
		);
		expect(Math.round(heading.getBoundingClientRect().width)).toBe(560);
	});

	/**
	 * THE CONTROL FORM IS UNTOUCHED, and this is the assertion that says the condition was put on
	 * the right branch. The same two figures, on the same component, in the mode 5b does not govern.
	 */
	it('keeps the 400 px column and the declared preview area outside recap mode', () => {
		const { command, previewSlot } = mount();

		expect(command.getBoundingClientRect().width).toBe(400);
		expect(previewSlot).not.toBeNull();
	});

	it('draws the table once the file carries real rows, with a header cell per column', () => {
		const { container } = mount({
			file: {
				...FILE,
				previewRows: [
					HEADERS.map((_, index) => `r0c${index}`),
					HEADERS.map((_, index) => `r1c${index}`)
				]
			}
		});

		const table = container.querySelector('table');
		expect(table).not.toBeNull();
		// One `<th>` per column of the file, and every one scoped — #363 measures 0 of 66 across
		// the product and new markup must not add to that figure.
		expect(table!.querySelectorAll('thead th').length).toBe(HEADERS.length);
		expect(table!.querySelectorAll('thead th[scope="col"]').length).toBe(HEADERS.length);
		// Two rows in, two rows out. The absolute figure, because a table that rendered one row
		// would satisfy "a table exists".
		expect(table!.querySelectorAll('tbody tr').length).toBe(2);
	});

	/**
	 * The plate's own arithmetic, pinned.
	 *
	 * « Tableau 806 = 1 230 − 400 − 24, puis 772 de contenu une fois sa propre bordure et ses
	 * 16 px de marge retirés. Colonne à 132 px, sauf le libellé désigné à 200 [...] 132 × 4 + 200
	 * = 728 dans 772 », header row 40, data rows 44 — « les 44 px viennent de la densité, pas de
	 * la règle tactile ».
	 *
	 * Every one of these was wrong on the first build: `table-layout: fixed` on a table with no
	 * stated width lays out against its CONTAINER, so the declared widths became proportions and
	 * a 13-column file drew nine columns in 774 px while the indicator beside them said five. The
	 * figures are asserted because they were briefly plausible and false together.
	 */
	it('lays the columns out at the plate figures rather than at whatever fitted', () => {
		const { container } = mount({
			file: { ...FILE, previewRows: [HEADERS.map((_, index) => `r0c${index}`)] },
			initialAssignment: { date: 0, label: 1, amount: 2, category: null }
		});

		const ths = [...container.querySelectorAll('thead th')] as HTMLElement[];
		// Widths are declared inline, so they are readable without a layout pass — which is what
		// makes this assertion possible in jsdom at all.
		const widthOf = (el: HTMLElement) => el.style.width;
		expect(widthOf(ths[0])).toBe('132px');
		// The column carrying the Libellé role, and only it, gets 200.
		expect(widthOf(ths[1])).toBe('200px');
		expect(widthOf(ths[2])).toBe('132px');
		// The table states its own width, which is the whole reason the widths above are absolute
		// rather than proportional.
		const table = container.querySelector('table') as HTMLElement;
		expect(table.style.width).toBe(`${132 * (HEADERS.length - 1) + 200}px`);
	});

	/**
	 * The direction this change is NOT moving in.
	 *
	 * The plate decided that designated columns are not pulled to the left: reordered, the preview
	 * becomes a second source of truth that contradicts the same file opened in a spreadsheet.
	 */
	it('leaves the columns in the file order rather than pulling designated ones left', () => {
		const { container } = mount({
			file: { ...FILE, previewRows: [HEADERS.map((_, index) => `r0c${index}`)] },
			initialAssignment: { date: 3, label: 1, amount: 5, category: null }
		});

		const cells = [...container.querySelectorAll('tbody tr:first-child td')].map((td) =>
			(td.textContent ?? '').trim()
		);
		expect(cells).toEqual(HEADERS.map((_, index) => `r0c${index}`));
	});

	it('still shows every value through the picker, which is why the table can wait', () => {
		// Ruling D2 widened to 1280: the values are read in the selector cards, exactly as at 390.
		// Without this the absence above would be a gap rather than a decision.
		const { container } = mount();

		expect(container.querySelectorAll('button[aria-haspopup="listbox"]').length).toBe(4);
	});
});

describe('the junction: a trigger and the thing it triggers, in one test, at each width', () => {
	/**
	 * THIS IS THE TEST WHOSE ABSENCE PRODUCED #334.
	 *
	 * Three levels covered this screen and every one of them was correct. `RoleRow.svelte.spec.ts`
	 * asserts the row is a `<button aria-haspopup="listbox">` that calls `onOpen`, true at every
	 * width. The geometry tests above assert the four buttons exist, at the right height, in a
	 * 400 px column, and never open one. The states spec DOES open pickers and pins 390, because
	 * the sheet needed it.
	 *
	 * Every level covered, every test correct, the junction covered nowhere. So the rule is: for any
	 * trigger, name the test where it and its target appear TOGETHER, at each width where both are
	 * supposed to exist. This is that test, and it runs at both.
	 *
	 * BREAK CHECK, run 2026-08-15: restoring `lg:hidden` on the anchored panel reddens the 1280 case
	 * and leaves the 390 case green. Red at one width only is the whole point: a break that reddened
	 * both would be a fact about the picker, and this defect was a fact about the WIDTH.
	 */
	/**
	 * THE VIEWPORT, not the container, and the first version of this block got that wrong.
	 *
	 * Every other test in this file sizes the CONTAINER to 1280x800, which is right for geometry and
	 * useless here: `lg:hidden` is a media query on the VIEWPORT, so a container-sized test cannot
	 * observe it at all. The break that restores `lg:hidden` came back green until this was added.
	 *
	 * That is #334's own failure mode arriving in the test written to prevent it: a measurement
	 * taken on the wrong box. The width has to be real for a width-conditional defect to exist.
	 */
	beforeEach(async () => {
		await page.viewport(1280, 800);
	});

	afterAll(async () => {
		await page.viewport(1280, 800);
	});

	const openFirstRole = async (container: HTMLElement) => {
		const row = container.querySelector('button[aria-haspopup="listbox"]') as HTMLElement;
		expect(row).not.toBeNull();
		row.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		return row;
	};

	it('opens a real, visible list of columns at 1280', async () => {
		const { container } = mount();

		await openFirstRole(container);

		// `offsetParent` is null for anything `display:none`, which is precisely how the defect
		// hid: the panel mounted, carried the right options, and could never be seen. A query that
		// only counted options would have passed throughout.
		const panel = container.querySelector('[data-testid="column-picker-panel"]') as HTMLElement;
		expect(panel).not.toBeNull();
		expect(panel.offsetParent).not.toBeNull();
		expect(panel.querySelectorAll('[role="option"]').length).toBe(FILE.headers.length);
	});

	it('anchors the panel under its own row and keeps it inside the window', async () => {
		// Measured FROM THE ANCHOR. A viewport fraction is not a constraint on a box that starts
		// partway down the page, which this repository measured once as a primary action at y=960.
		const { container } = mount();

		const row = await openFirstRole(container);
		const panel = container.querySelector('[data-testid="column-picker-panel"]') as HTMLElement;

		expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			row.getBoundingClientRect().bottom
		);
		expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
	});

	it('opens a real, visible list of columns at 390 too, through the other shell', async () => {
		// The same journey through the sheet. Asserted here rather than left to the states spec so
		// that ONE test file carries both widths: the defect was that no file did.
		await page.viewport(390, 844);
		const { container } = mount({ wide: false });

		await openFirstRole(container);

		const options = [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
		expect(options.length).toBe(FILE.headers.length);
		expect(options.filter((option) => option.offsetParent !== null).length).toBe(
			FILE.headers.length
		);
	});
});
