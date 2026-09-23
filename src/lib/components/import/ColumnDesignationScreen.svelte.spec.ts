import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import * as m from '$lib/paraglide/messages';
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
 *    load-bearing one and the defect that calibration was written to find.
 *
 *    **A FLEX COLUMN SHRINKS ITS ITEMS BEFORE IT SCROLLS.** Without `shrink-0` the slot silently
 *    shrank back instead of overflowing, so `does not scroll, in any state` was passing over a body
 *    that HAD NO WAY to scroll. The assertion was true and meant nothing.
 *
 *    That is why `scrolls the BODY and never the page when content does overflow` exists, and it is
 *    the same shape as pointing a leak detector at a real leak or a searcher at a string known to be
 *    present: **prove the thing can be present before asserting it is absent.** Anyone maintaining
 *    the overflow test is meeting this note at the point they would otherwise delete it as
 *    redundant with the four height assertions above.
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
	detectedHeaderRow: true
};

const PARTIAL: RoleAssignment = { date: 0, label: null, amount: null, category: null };
const COMPLETE: RoleAssignment = { date: 0, label: 2, amount: 5, category: 7 };

async function mount(props: Record<string, unknown> = {}) {
	const { container } = await render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: EMPTY_ASSIGNMENT,
		/**
		 * A RESOLVED account in every mount, so a press reaches what these tests measure.
		 *
		 * The account row refuses the primary until one is chosen, which is its own behaviour with
		 * its own tests. Leaving it unchosen here would make every press in this file measure that
		 * guard instead of the thing it names.
		 */
		accounts: [
			{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
		],
		initialAccountId: 'account-1',
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
	it('is 56 + 636 + 64 + 88, and those add to the 844 the screen occupies', async () => {
		const { screen, header, body, banner, footer } = await mount();

		const heights = [header, body, banner, footer].map((el) => el.getBoundingClientRect().height);
		expect(heights).toStrictEqual([56, 636, 64, 88]);
		// The sum asserted separately from the parts: four correct figures that do not add up would
		// mean something else on the screen is absorbing the difference.
		expect(heights.reduce((a, b) => a + b, 0)).toBe(844);
		expect(screen.getBoundingClientRect().height).toBe(844);
		expect(screen.getBoundingClientRect().width).toBe(390);
	});

	it('caps the body at 636 rather than letting it grow, which a bare 1fr would not', async () => {
		// A `1fr` track has `min-height: auto`, refuses to shrink below its content, and the cap is
		// then silently ignored: the page grows and the banner leaves the screen, in exactly the
		// states with the most content. Measured under BREAK 1: the body reads 636 either way in
		// these states because the content is only 449, so this assertion is NOT what catches it.
		// The one that does is the overflow test below, run against a deliberately overfull body.
		const { body } = await mount();

		expect(body.getBoundingClientRect().height).toBe(636);
		expect(getComputedStyle(body).overflowY).toBe('auto');
	});
});

describe("the body's 449 of 636, which is the plate's promise", () => {
	const contentHeight = (body: HTMLElement) => {
		const last = body.lastElementChild as HTMLElement;
		const paddingBottom = parseFloat(getComputedStyle(body).paddingBottom);
		return last.getBoundingClientRect().bottom - body.getBoundingClientRect().top + paddingBottom;
	};

	it('is 549 in state 0, leaving 87 px of air', async () => {
		// 16 padding + 40 file block + 14 gap + 68 account row + 14 gap + 373 card + 24 padding.
		//
		// Separates « the body has room the design can still spend » from « it is already full ».
		// A bound would answer neither, which is why this is restated as an exact figure every time
		// it moves rather than relaxed to a range: a range stops the test noticing the next thing
		// that grows, and three separate things have grown here.
		//
		// WAS 531, AND THE 18 IS EXACTLY ONE ROW'S READING LINE. The account row did NOT move and
		// the card did, by 18 and not by 72, because only the DATE row carries an interpretation
		// slot: the other three roles have nothing to interpret and stay at 68. That is the check
		// worth reading off this figure, and the row assertion below states it directly.
		//
		// The slot's height is PRESENCE driven and never VALUE driven, so the Date row is 86 whether
		// its line 3 states a proof, asks for a confirmation, or says the column holds no dates.
		// Nothing on this screen moves when a reading is answered.
		//
		// WAS 449 BEFORE THAT. The account row added 82 where plate 6b predicted 81; the one-pixel
		// difference is the row's own 68 against the 14 px body gap, recorded rather than rounded
		// away. And 511 before THAT, the 62 px difference being the « Format du fichier » row plus
		// its gap, deleted because a visible empty affordance is a promise.
		const { body } = await mount();

		expect(contentHeight(body)).toBe(549);
		expect(636 - contentHeight(body)).toBe(87);
	});

	it('is still 549 in state 1, because designating a row does not move anything', async () => {
		// The promise is that nothing shifts as answers arrive. Separates « the layout is stable
		// under answers » from « each answer nudges everything below it », which is the whole reason
		// the row height is decided by presence rather than by content.
		//
		// State 2 is excluded on purpose and gets its own figure below: it is the one state that
		// legitimately adds content.
		const { body } = await mount({ initialAssignment: PARTIAL });

		expect(contentHeight(body)).toBe(549);
	});

	it('is 611 in state 2, which is the 62 px the memorisation link adds', async () => {
		// 48 for the opt-out TapLink, plus the 14 px gap. Separates « state 2 fits » from « state 2
		// scrolls », which is the one geometric promise the plate makes about this screen, and the
		// second assertion is what turns the figure into that claim rather than a number beside it.
		//
		// THIS IS THE STATE THE WHOLE MEMORISATION SPLIT WAS FOR, and the arithmetic is worth having
		// here because it is the only place it can be checked. The Date row's line 3 costs 18 px in
		// every state. Before the split this state measured 549 + 14 + 86 = 649 against a body capped
		// at 636, so the screen scrolled: 13 px over, not the 7 px spare the plate predicted, because
		// the plate was sized against a base that still carried the « Format du fichier » row.
		//
		// The block was 34 (sentence) + 4 (gap) + 48 (link) = 86. Moving the SENTENCE to the import
		// summary and leaving the LINK here takes it to 48, so 549 + 14 + 48 = 611 with 25 px of air.
		// 611 is the plate's own original state-2 figure, reached by moving a disclosure rather than
		// by shrinking anything to fit.
		//
		// The LINK did not move and that half is not arithmetic: storing the mapping with no opt-out
		// in reach before the write is a consent taken rather than given.
		const { body } = await mount({ initialAssignment: COMPLETE });

		expect(contentHeight(body)).toBe(611);
		expect(636 - contentHeight(body)).toBe(25);
		expect(body.scrollHeight).toBe(body.clientHeight);
	});

	it('ends the card at 525 of 636', async () => {
		// 16 + 40 + 14 + 68 + 14 + 373. The second figure the plate calls the promise, and it is about
		// a POSITION rather than a size, so no height assertion can stand in for it. Separates « the
		// card ends where the plate puts it » from « the card is the right height somewhere else »,
		// which every height assertion above is blind to.
		//
		// WAS 507, AND IT MOVED BY EXACTLY THE CARD'S OWN 18. That is what says the growth happened
		// INSIDE the card rather than above it: had the account row or the file block grown too,
		// this figure would have moved further than the card's height did, and no height assertion
		// anywhere can tell those two apart.
		const { body, card } = await mount();

		expect(card.getBoundingClientRect().bottom - body.getBoundingClientRect().top).toBe(525);
	});

	it('does not scroll, in any state', async () => {
		for (const initialAssignment of [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE]) {
			const { body, container } = await mount({ initialAssignment });
			expect(body.scrollHeight).toBe(body.clientHeight);
			container.remove();
		}
	});

	it('scrolls the BODY and never the page when content does overflow', async () => {
		// The calibration for the test above: an assertion that nothing scrolls is worth nothing
		// until the detector has been shown a real overflow. The reserved slot is grown past the
		// available air, and the body must absorb it rather than the screen growing.
		const { body, screen } = await mount();
		const slot = body.lastElementChild as HTMLElement;
		slot.style.height = '900px';

		expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
		expect(body.getBoundingClientRect().height).toBe(636);
		expect(screen.getBoundingClientRect().height).toBe(844);
	});
});

describe('the card and its rows', () => {
	it('is 373 px, whatever the four rows are showing', async () => {
		// 14 padding + 16 label + 10 gap + (86 + 1 + 68 + 1 + 68) + 12 + 1 + 12 + 68 + 14 padding
		// + 2 border. The stronger separator before the optional row is 25 of those, and it is what
		// marks Categorie as a different kind of thing without an asterisk anywhere.
		//
		// WAS 355, AND THE 18 IS ONE ROW RATHER THAN FOUR. Only the Date row interprets, so only it
		// is 86; the three others are unchanged at 68. Separates « the interpreting row grew » from
		// « every row grew », which differ by 54 px and would both have satisfied a test asserting
		// only that the card is taller than it was.
		//
		// The loop over three states is what makes this a constant rather than a reading of one
		// state: the card must not move as roles are answered.
		for (const initialAssignment of [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE]) {
			const { card, container } = await mount({ initialAssignment });
			expect(card.getBoundingClientRect().height).toBe(373);
			container.remove();
		}
	});

	it('draws four rows, one per ROLE, and only the interpreting one is 86', async () => {
		// The structural decision the whole design rests on. This file has fifteen columns and the
		// card has four rows; a fifteen-column file must cost the same vertical space as a
		// three-column one, which is what makes the 373 a constant.
		//
		// THE FOUR ROWS ARE NOT THE SAME HEIGHT ANY MORE, and this test says so in the two figures
		// rather than in a comment. `MAPPING_ROLES` is `['date', 'label', 'amount', 'category']`, so
		// index 0 is the Date row, it is the only one handed an `interpretation`, and it is the only
		// one at 86. The other three are unchanged at 68.
		//
		// Separates « only the row with something to interpret grew » from « every row grew », which
		// differ by 54 px on the card. Both satisfy « the card is taller than it was », which is why
		// the per-row figures are asserted and not the card alone.
		//
		// The 86 follows the PRESENCE of the slot and never its VALUE, so the Date row does not move
		// when its reading is answered, withdrawn, or found inconsistent. That is what the three
		// states in the card assertion above are checking, from the other side.
		const { card } = await mount();

		const rows = card.querySelectorAll('button[aria-haspopup="listbox"]');
		expect(rows.length).toBe(4);
		expect(FILE.headers.length).toBe(15);
		expect(rows[0].getBoundingClientRect().height).toBe(86);
		for (const row of [rows[1], rows[2], rows[3]]) {
			expect(row.getBoundingClientRect().height).toBe(68);
		}
	});
});

describe('the banner does not move between states, which is a relational promise', () => {
	it('holds the same height AND the same top across states 0, 1 and 2', () => {
		// A single-element measurement cannot answer a question about a difference, so this reads
		// both states and compares. The absolute 64 is asserted too: a comparison alone passes in a
		// world with no stylesheet, where every state agrees at the same wrong number.
		const readings = [EMPTY_ASSIGNMENT, PARTIAL, COMPLETE].map(async (initialAssignment) => {
			const { banner, screen, container } = await mount({ initialAssignment });
			const box = banner.getBoundingClientRect();
			const reading = { height: box.height, top: box.top - screen.getBoundingClientRect().top };
			container.remove();
			return reading;
		});

		expect(readings[0]).toStrictEqual({ height: 64, top: 692 });
		expect(readings[1]).toStrictEqual(readings[0]);
		expect(readings[2]).toStrictEqual(readings[0]);
	});

	it('sits between the body and the footer, not over them', async () => {
		// The reason this is a grid track rather than `position: sticky; bottom: 0`. A bottom-sticky
		// element is painted at the scrollport's bottom edge for as long as its containing block
		// runs past that edge, so "sticky" and "must not cover content" are not jointly satisfiable.
		// Asserted as a non-overlap, which is the property that actually failed last time.
		const { body, banner, footer } = await mount();

		expect(banner.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			body.getBoundingClientRect().bottom
		);
		expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			banner.getBoundingClientRect().bottom
		);
	});
});

/**
 * Planche 5c: the correction consent moves to the moment the question forms.
 *
 * Above the file picker it asked the fate of the old import BEFORE the file was chosen, before the
 * correction, and before knowing the correction would succeed. In the designation footer it sits
 * where the user has just changed the offending role, reads « Importer N lignes » and asks
 * themselves the question. The order the deduplication key imposes does not change (correct first,
 * delete second); the control finally expresses that order instead of contradicting it.
 */
describe('5c, the consent to replace and the confirmation that carries it', () => {
	const REPLACES = {
		batchId: 'batch-old',
		namedAt: '1 juillet 2026 à 10:59',
		replacedRows: 25,
		hasUserWork: false
	};

	async function withConsent(props: Record<string, unknown> = {}) {
		return await mount({ initialAssignment: COMPLETE, replaces: REPLACES, ...props });
	}

	// THE ROUTE-PRODUCES-IT CHECK, paid first. Absent a batch to replace there is nothing to choose,
	// and a ticked box promising a deletion that cannot happen is the defect this wave removes.
	it('renders no consent when nothing is being replaced', async () => {
		const { container } = await mount({ initialAssignment: COMPLETE });

		expect(container.querySelector('[data-testid="designation-replace-consent"]')).toBeNull();
	});

	// Owner ruling: PRE-TICKED. « No default pre-arms an irreversible » holds when nothing else
	// consents; the destructive confirmation of this same section consents and names both facts, so
	// the box proposes rather than arms. Asserted as the input's VALUE, not as an attribute string:
	// `defaultChecked` and `checked` diverge the moment anything toggles it.
	it('is ticked by default', async () => {
		const { container } = await withConsent();
		const box = container.querySelector<HTMLInputElement>(
			'[data-testid="designation-replace-consent"] input[type="checkbox"]'
		);

		expect(box).not.toBeNull();
		expect(box!.checked).toBe(true);
	});

	// THE SIBLING ASSERTION, and 5b is why it is written this way. Measuring the consent against the
	// footer and the primary against the footer would both pass with the two in the wrong order.
	// This compares the two elements the decision relates.
	// THE ORDER IS THE MEANING: the box (an option), the count (a fact), the primary (the act), the
	// exit. Asserted as three siblings compared against EACH OTHER rather than each against the
	// screen, which is the shape 5b's misplaced heading taught: every figure can be right while two
	// elements sit in the wrong order relative to one another.
	//
	// Built with the consent inside the footer first, which put the count above it. Nothing failed;
	// the screenshot is what showed it.
	it('sits above the count, which sits above the primary', async () => {
		const { container } = await withConsent();
		const consent = container.querySelector('[data-testid="designation-replace-consent"]')!;
		const banner = container.querySelector('[data-testid="condition-banner"]')!;
		const primary = container.querySelector('[data-testid="designation-primary"]')!;

		const top = (el: Element) => el.getBoundingClientRect().top;
		expect(top(consent)).toBeLessThan(top(banner));
		expect(top(banner)).toBeLessThan(top(primary));
	});

	// The label NAMES the import it destroys. « Supprimer l'ancien import » names nothing once a
	// user holds several, and this flow's ordinary shape is two imports of one statement minutes
	// apart: the blind session ended in exactly that state, unable to tell the two rows apart.
	it('names the import it would delete, by the timestamp', async () => {
		const { container } = await withConsent();
		const consent = container.querySelector('[data-testid="designation-replace-consent"]')!;

		expect(consent.textContent).toContain('1 juillet 2026 à 10:59');
	});

	// The cost note appears only when there is a cost. A warning about a loss that cannot occur is
	// discounted every time after, and then it is not read on the one run where it was true.
	it('states the split-and-tag cost only when the batch carries user work', async () => {
		const without = await withConsent();
		const withWork = await mount({
			initialAssignment: COMPLETE,
			replaces: { ...REPLACES, hasUserWork: true }
		});
		const noteOf = (c: { container: Element }) =>
			c.container.querySelector('[data-testid="designation-replace-consent"] p')?.textContent ?? '';

		expect(noteOf(without)).toBe('');
		expect(noteOf(withWork).length).toBeGreaterThan(0);
	});

	// The note is the sentence the explicit delete ALREADY shows, not a second wording for one fact.
	// Two wordings is how two screens start disagreeing about what a deletion costs, and this is the
	// one figure the user has to match across them.
	it('reuses the cost sentence the explicit delete already shows', async () => {
		const { container } = await mount({
			initialAssignment: COMPLETE,
			replaces: { ...REPLACES, hasUserWork: true }
		});
		const note = container.querySelector('[data-testid="designation-replace-consent"] p');

		expect(note?.textContent).toBe(m.imports_delete_cost_note());
	});

	// BOTH CHROMES. A control wired into one mount and silently missing from the other is invisible
	// to every test that does not choose a width, and this repository has shipped that shape more
	// than once. At 1280 the consent lives in the sticky command foot rather than in a footer, so
	// the assertion is that it sits inside the box that travels with the primary.
	it('renders in the 1280 chrome too, inside the box that travels with the primary', async () => {
		const { container } = await mount({
			initialAssignment: COMPLETE,
			replaces: REPLACES,
			wide: true
		});
		const consent = container.querySelector('[data-testid="designation-replace-consent"]');
		const foot = container.querySelector('[data-testid="designation-command-foot"]');

		expect(consent).not.toBeNull();
		expect(foot!.contains(consent!)).toBe(true);
	});

	// Ticked, the press PROPOSES and the confirmation consents. A test that only presses the primary
	// and checks onSubmit would lock in the defect where a tick alone destroys.
	it('opens the destructive confirmation instead of submitting, when ticked', async () => {
		let submitted: unknown = null;
		const { container } = await withConsent({ onSubmit: (r: unknown) => (submitted = r) });

		(container.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		expect(submitted).toBeNull();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	// The mirror case, and it is what makes the pair meaningful: unticked, nothing irreversible is
	// in play, so the press imports directly and no modal is mounted.
	it('imports directly, with no confirmation, when unticked', async () => {
		let submitted: { deleteOldImport?: boolean } | null = null;
		const { container } = await withConsent({
			onSubmit: (r: { deleteOldImport?: boolean }) => (submitted = r)
		});
		const box = container.querySelector<HTMLInputElement>(
			'[data-testid="designation-replace-consent"] input[type="checkbox"]'
		)!;
		box.click();
		await new Promise((r) => setTimeout(r, 0));

		(container.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(submitted).not.toBeNull();
		expect(submitted!.deleteOldImport).toBe(false);
	});

	// The title names BOTH facts, which is what a confirmation for a compound act owes the reader.
	// Asserted positively on the title node: a negative assertion over the dialog's concatenated
	// text cannot match.
	it('the confirmation names the rows imported and the import deleted, in one title', async () => {
		const { container } = await withConsent();
		(container.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		const title = document.querySelector('[role="dialog"] h2')!;
		expect(title.textContent).toContain('132');
		expect(title.textContent).toContain('1 juillet 2026 à 10:59');
	});

	// TWO DIFFERENT NUMBERS, and the break matrix is what showed the second was unasserted. The title
	// counts the rows about to be IMPORTED, from the new file; the body counts the rows about to be
	// REMOVED, from the old import. A fixture where both were 25, as the plate's example has them,
	// could not tell the two apart, so this one makes them 132 and 25.
	it('the body counts the old import rows, which is not the number in the title', async () => {
		const { container } = await withConsent({
			replaces: { ...REPLACES, replacedRows: 25 }
		});
		(container.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		// The testid and not `[role="dialog"] p`: the dialog's own mobile header renders the TITLE in a
		// paragraph, so the bare selector reads the title back and the test asserts nothing about the
		// body. Found by this assertion failing against a title it was not about.
		const body = document.querySelector('[data-testid="replace-confirm-body"]')!;
		expect(body.textContent).toContain('25');
		expect(body.textContent).not.toContain('132');
	});

	// Confirming is what reaches onSubmit, and it carries the consent.
	it('confirming submits with the consent attached', async () => {
		let submitted: { deleteOldImport?: boolean } | null = null;
		const { container } = await withConsent({
			onSubmit: (r: { deleteOldImport?: boolean }) => (submitted = r)
		});
		(container.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
			b.textContent?.includes('Importer et supprimer')
		) as HTMLElement;
		confirm.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(submitted).not.toBeNull();
		expect(submitted!.deleteOldImport).toBe(true);
	});

	// The primary keeps its words either way. « Importer et supprimer » on the footer would put two
	// verbs on one action and make the label depend on a checkbox sitting above it.
	it('the primary reads « Importer 132 lignes » ticked or unticked', async () => {
		const { container } = await withConsent();
		const primary = container.querySelector('[data-testid="designation-primary"]')!;
		const ticked = primary.textContent;

		const box = container.querySelector<HTMLInputElement>(
			'[data-testid="designation-replace-consent"] input[type="checkbox"]'
		)!;
		box.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(primary.textContent).toBe(ticked);
		expect(primary.textContent).toContain('132');
	});
});
