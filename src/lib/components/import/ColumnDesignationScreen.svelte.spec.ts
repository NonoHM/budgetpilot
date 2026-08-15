import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * The plate's cotes, asserted as figures rather than as relations.
 *
 * `layout.css` is imported because every number here is a real measurement: without it these read
 * plausible values instead of failing, which this repository has measured at 44 px reading as 24 and
 * at eighteen green assertions over a deliberately broken height.
 *
 * The screen is sized by its CONTAINER (`h-full w-full`) rather than by a fixed class of its own, so
 * the route can give it the viewport and this spec can give it exactly 390x844. A component that
 * pinned its own 844 would measure a box no user ever sees.
 *
 * BREAK MATRIX, read per test, run 2026-08-15. Four breaks, and the two greens are the findings.
 *
 * 1. Header `h-14` to `h-16`: **three red**, reading `[64, 628, 64, 88]` against `[56, 636, 64, 88]`.
 *    The body absorbs the difference, which is the grid working, and the sum still makes 844. That
 *    is exactly why the four heights are asserted individually AND summed: the sum alone cannot
 *    tell a correct stack from a header that stole 8 px from the body.
 *
 * 2. `minmax(0, 1fr)` to a bare `1fr`, which the plan names as the shape to avoid: **ALL ELEVEN
 *    GREEN, including the overflow calibration.** Recorded rather than papered over, because the
 *    conclusion is not "the plan is wrong" but "it does not bite in THIS configuration". A grid
 *    item's automatic minimum size is content-based only while its `overflow` is `visible`; the
 *    body is a scroll container (`overflow-y: auto`), so its automatic minimum is already zero and
 *    the two spellings compute identically. The `minmax(0, 1fr)` is kept anyway: it is explicit,
 *    it costs nothing, and it stops being redundant the day somebody removes the overflow. What is
 *    NOT claimed is that a test guards it. Nothing here does, and no test can while the body
 *    scrolls.
 *
 * 3. Remove `shrink-0` from the RESERVED SLOT: **one red**, the overflow calibration. This is the
 *    load-bearing one and the defect that calibration was written to find: a flex column shrinks
 *    its items before it scrolls, so the slot silently shrank back instead of overflowing.
 *
 * 4. Remove `shrink-0` from the CARD: **all eleven green**, and it is a fact about the card rather
 *    than about the tests. The card's height comes from content with fixed heights, so its
 *    automatic minimum size already equals its 355 and it cannot shrink below it. Same for the file
 *    block. Only the reserved slot, which is `h-12` around no content at all, can shrink to zero.
 *    All three keep `shrink-0` for uniformity and against future content, and this note is here so
 *    the next person to break one and see green knows it is expected.
 */
const HEADERS = [
	'Date operation',
	'Date valeur',
	'Libelle',
	'Debit',
	'Credit',
	'Montant',
	'Reference',
	'Categorie',
	'Solde',
	'Devise',
	'Type',
	'Canal',
	'Pays',
	'Note',
	'Statut'
];

const FILE = {
	name: 'releve-juin-2026.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	rowCount: 132,
	hasHeaderRow: true
};

const PARTIAL: RoleAssignment = { date: 0, label: null, amount: null, category: null };
const COMPLETE: RoleAssignment = { date: 0, label: 2, amount: 5, category: 7 };

function mount(props: Record<string, unknown> = {}) {
	const { container } = render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		...props
	});
	// 390x844 exactly, which is what every figure below was drawn against.
	container.style.width = '390px';
	container.style.height = '844px';
	const pick = (testid: string) =>
		container.querySelector(`[data-testid="${testid}"]`) as HTMLElement;
	return {
		container,
		screen: pick('designation-screen'),
		header: pick('designation-header'),
		body: pick('designation-body'),
		card: pick('designation-card'),
		banner: pick('condition-banner'),
		footer: pick('designation-footer')
	};
}

describe('the four regions, and their sum is the screen', () => {
	/**
	 * BREAK 1: `grid-rows-[auto_minmax(0,1fr)_auto_auto]` to `auto_1fr_auto_auto`.
	 * BREAK 2: header `h-14` to `h-16`.
	 * Both run; results recorded in the tests they redden.
	 */
	it('is 56 + 636 + 64 + 88, and those add to the 844 the screen occupies', () => {
		const { screen, header, body, banner, footer } = mount();

		const heights = [header, body, banner, footer].map((el) => el.getBoundingClientRect().height);
		expect(heights).toStrictEqual([56, 636, 64, 88]);
		// The sum asserted separately from the parts: four correct figures that do not add up would
		// mean something else on the screen is absorbing the difference.
		expect(heights.reduce((a, b) => a + b, 0)).toBe(844);
		expect(screen.getBoundingClientRect().height).toBe(844);
		expect(screen.getBoundingClientRect().width).toBe(390);
	});

	it('caps the body at 636 rather than letting it grow, which a bare 1fr would not', () => {
		// A `1fr` track has `min-height: auto`, refuses to shrink below its content, and the cap is
		// then silently ignored: the page grows and the banner leaves the screen, in exactly the
		// states with the most content. Measured under BREAK 1: the body reads 636 either way in
		// these states because the content is only 511, so this assertion is NOT what catches it.
		// The one that does is the overflow test below, run against a deliberately overfull body.
		const { body } = mount();

		expect(body.getBoundingClientRect().height).toBe(636);
		expect(getComputedStyle(body).overflowY).toBe('auto');
	});
});

describe("the body's 511 of 636, which is the plate's promise", () => {
	const contentHeight = (body: HTMLElement) => {
		const last = body.lastElementChild as HTMLElement;
		const paddingBottom = parseFloat(getComputedStyle(body).paddingBottom);
		return last.getBoundingClientRect().bottom - body.getBoundingClientRect().top + paddingBottom;
	};

	it('is 511 in state 0, leaving 125 px of air', () => {
		// 16 padding + 40 file block + 14 gap + 355 card + 14 gap + 48 reserved slot + 24 padding.
		const { body } = mount();

		expect(contentHeight(body)).toBe(511);
		expect(636 - contentHeight(body)).toBe(125);
	});

	it('is still 511 in state 1, because designating a row does not move anything', () => {
		// The promise is that nothing shifts as answers arrive. State 2 is excluded on purpose and
		// gets its own figure below: it is the one state that legitimately adds content.
		const { body } = mount({ initialAssignment: PARTIAL });

		expect(contentHeight(body)).toBe(511);
	});

	it('is 611 in state 2, which is the 100 px the memorisation block adds', () => {
		// 86 for the sentence and its opt-out link, plus the 14 px gap. The plate carries this
		// figure separately from the 511 precisely because it is the one state that grows, and the
		// point of stating it is that 611 is still under 636: the screen does not begin to scroll.
		const { body } = mount({ initialAssignment: COMPLETE });

		expect(contentHeight(body)).toBe(611);
		expect(body.scrollHeight).toBe(body.clientHeight);
	});

	it('ends the card at 425 of 636', () => {
		// 16 + 40 + 14 + 355. The second figure the plate calls the promise, and it is about a
		// POSITION rather than a size, so no height assertion can stand in for it.
		const { body, card } = mount();

		expect(card.getBoundingClientRect().bottom - body.getBoundingClientRect().top).toBe(425);
	});

	it('does not scroll, in any state', () => {
		for (const initialAssignment of [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE]) {
			const { body, container } = mount({ initialAssignment });
			expect(body.scrollHeight).toBe(body.clientHeight);
			container.remove();
		}
	});

	it('scrolls the BODY and never the page when content does overflow', () => {
		// The calibration for the test above: an assertion that nothing scrolls is worth nothing
		// until the detector has been shown a real overflow. The reserved slot is grown past the
		// available air, and the body must absorb it rather than the screen growing.
		const { body, screen } = mount();
		const slot = body.lastElementChild as HTMLElement;
		slot.style.height = '900px';

		expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
		expect(body.getBoundingClientRect().height).toBe(636);
		expect(screen.getBoundingClientRect().height).toBe(844);
	});
});

describe('the card and its rows', () => {
	it('is 355 px, whatever the four rows are showing', () => {
		// 14 padding + 16 label + 10 gap + (68 + 1 + 68 + 1 + 68) + 12 + 1 + 12 + 68 + 14 padding
		// + 2 border. The stronger separator before the optional row is 25 of those, and it is what
		// marks Categorie as a different kind of thing without an asterisk anywhere.
		for (const initialAssignment of [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE]) {
			const { card, container } = mount({ initialAssignment });
			expect(card.getBoundingClientRect().height).toBe(355);
			container.remove();
		}
	});

	it('draws four rows at 68 px, one per ROLE and never one per column', () => {
		// The structural decision the whole design rests on. This file has fifteen columns and the
		// card has four rows; a fifteen-column file must cost the same vertical space as a
		// three-column one, which is what makes the 355 a constant.
		const { card } = mount();

		const rows = card.querySelectorAll('button[aria-haspopup="listbox"]');
		expect(rows.length).toBe(4);
		expect(FILE.headers.length).toBe(15);
		for (const row of rows) {
			expect(row.getBoundingClientRect().height).toBe(68);
		}
	});
});

describe('the banner does not move between states, which is a relational promise', () => {
	it('holds the same height AND the same top across states 0, 1 and 2', () => {
		// A single-element measurement cannot answer a question about a difference, so this reads
		// both states and compares. The absolute 64 is asserted too: a comparison alone passes in a
		// world with no stylesheet, where every state agrees at the same wrong number.
		const readings = [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE].map((initialAssignment) => {
			const { banner, screen, container } = mount({ initialAssignment });
			const box = banner.getBoundingClientRect();
			const reading = { height: box.height, top: box.top - screen.getBoundingClientRect().top };
			container.remove();
			return reading;
		});

		expect(readings[0]).toStrictEqual({ height: 64, top: 692 });
		expect(readings[1]).toStrictEqual(readings[0]);
		expect(readings[2]).toStrictEqual(readings[0]);
	});

	it('sits between the body and the footer, not over them', () => {
		// The reason this is a grid track rather than `position: sticky; bottom: 0`. A bottom-sticky
		// element is painted at the scrollport's bottom edge for as long as its containing block
		// runs past that edge, so "sticky" and "must not cover content" are not jointly satisfiable.
		// Asserted as a non-overlap, which is the property that actually failed last time.
		const { body, banner, footer } = mount();

		expect(banner.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			body.getBoundingClientRect().bottom
		);
		expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			banner.getBoundingClientRect().bottom
		);
	});
});
