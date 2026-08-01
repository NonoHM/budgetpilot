import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { SubmitFunction } from '@sveltejs/kit';
import '../layout.css';
import Page from './+page.svelte';
import { formatAmountRangeBounds, toBillRowDomKey } from '$lib/domain/upcomingBills';
import { formatCents } from '$lib/domain/budget';
import type { UpcomingBillRowView } from '$lib/server/upcoming-bills/service';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * `use:enhance` is replaced by a recorder rather than stubbed out, so the page's own submit
 * functions stay under test: the focus decisions live inside them, and they are exactly what a
 * DOM-only assertion cannot reach. The test then drives one by hand with a synthetic success and an
 * `update` that re-renders the post-mutation data — which is what makes the period `$effect` fire
 * for real, the detail the collapsed-group bug hid behind.
 */
const submitted = vi.hoisted(() => [] as { node: HTMLFormElement; submit: SubmitFunction }[]);

vi.mock('$app/forms', () => ({
	enhance: (node: HTMLFormElement, submit: SubmitFunction) => {
		submitted.push({ node, submit });
		return {};
	}
}));

/** The recorded submit function of the (single) form posting to `action`. */
function submitFunctionFor(action: string): SubmitFunction {
	const entries = submitted.filter((entry) => entry.node.getAttribute('action') === action);
	expect(entries.length).toBe(1);
	return entries[0].submit;
}

/** Runs a recorded submit function through one successful round trip. */
async function runSubmit(action: string, applyUpdate: () => Promise<void>) {
	const callback = submitFunctionFor(action)({} as Parameters<SubmitFunction>[0]);
	if (typeof callback !== 'function') throw new Error('submit function returned no callback');
	await callback({
		result: { type: 'success', status: 200 },
		update: applyUpdate
	} as unknown as Parameters<Exclude<Awaited<ReturnType<SubmitFunction>>, void>>[0]);
}

const TODAY_ISO = '2026-07-31';

// Typed factory rather than an object literal per test: TypeScript narrows a literal's `null`
// fields to `null`, so a spec that later assigns a string to one passes vitest (esbuild strips
// types) and fails `npm run check`. See CLAUDE.md, "a green vitest says nothing about types".
function buildRow(overrides: Partial<UpcomingBillRowView> = {}): UpcomingBillRowView {
	return {
		rowKey: 'expense:netflix:2026-07-31:0',
		label: 'Netflix',
		initials: 'NF',
		category: 'Abonnements',
		direction: 'expense',
		tier: 'confirmed',
		occurrenceCount: 6,
		cadence: 'monthly',
		anchorDayOfMonth: 31,
		dateIso: TODAY_ISO,
		status: 'upcoming',
		daysLate: null,
		estimatePassed: false,
		settledKind: null,
		amountCents: -1349,
		averageAmountCents: 1349,
		minAmountCents: 1349,
		maxAmountCents: 1349,
		variability: 'fixed',
		countsInRemainingTotal: true,
		appliedActionId: null,
		actionPayload: {
			direction: 'expense',
			normalizedLabel: 'netflix',
			label: 'NETFLIX.COM',
			dueDate: TODAY_ISO,
			anchorTransactionIds: '[]'
		},
		...overrides
	};
}

function buildData(overrides: Partial<PageData['bills']> = {}): PageData {
	return {
		bills: {
			month: '2026-07',
			todayIso: TODAY_ISO,
			isCurrentMonth: true,
			isFutureMonth: false,
			// 12 months before TODAY_ISO, i.e. the month the detection window starts in.
			oldestNavigableMonth: '2025-07',
			streamCount: 1,
			remainingExpenseCents: 1349,
			expectedIncomeCents: 0,
			rows: [buildRow()],
			observationCandidates: [],
			excludedStreams: [],
			...overrides
		}
	} as PageData;
}

describe('/upcoming-bills page', () => {
	beforeEach(async () => {
		submitted.length = 0;
		// The viewport is shared across a file, and two tests below change it. Reset to desktop so
		// neither leaks into whatever runs next.
		await page.viewport(1280, 900);
	});

	// Locked decision, asserted at the RENDER layer as well as in the domain: a stream at the
	// uncertain tier can never carry "En retard", however long its estimated date has been past.
	// The domain guarantees `status: 'upcoming'` / `daysLate: null` for it; this proves the page
	// does not re-derive lateness from the date on its own.
	it('renders an uncertain-tier row whose estimated date is long past as "À venir", never "En retard"', async () => {
		const { container } = render(Page, {
			data: buildData({
				rows: [
					buildRow({
						rowKey: 'expense:spotify family:2026-05-18:0',
						label: 'Spotify Family',
						tier: 'uncertain',
						occurrenceCount: 2,
						// Two months past, and the row is still open.
						dateIso: '2026-05-18',
						status: 'upcoming',
						daysLate: null,
						estimatePassed: true,
						countsInRemainingTotal: false
					})
				]
			})
		});

		expect(container.textContent).toContain('À venir');
		expect(container.textContent).not.toContain('En retard');
		// The date-passed copy IS shown; it is a display flag, not a lateness claim.
		expect(container.textContent).toContain('date estimée dépassée');
		// And it is excluded from the period total, in words.
		expect(container.textContent).toContain('hors total');
	});

	// C1 + I1. Written RED before the fix: the page used to key the disabled navigator and the
	// "engine is still observing" copy off `rows.length`, which walls in any user whose streams all
	// fall outside the displayed month (a yearly bill: eleven months out of twelve). `streamCount`
	// is the predicate that distinguishes "nothing detected, ever" from "nothing due here".
	it('keeps both period arrows reachable when streams exist but this month holds none of them', async () => {
		const { container } = render(Page, {
			data: buildData({ streamCount: 4, rows: [], remainingExpenseCents: 0 })
		});

		const arrows = container.querySelectorAll('a[aria-label]');
		expect(arrows.length).toBe(2);
		for (const arrow of arrows) {
			expect(arrow.hasAttribute('href')).toBe(true);
			expect(arrow.getAttribute('aria-disabled')).toBeNull();
			expect(arrow.className).not.toContain('pointer-events-none');
		}

		// And the copy does not claim the engine found nothing.
		expect(container.textContent).not.toContain('Aucun flux récurrent détecté');
		expect(container.textContent).not.toContain('Le moteur observe encore');
		expect(container.textContent).toContain('Rien de prévu en');
	});

	it('disables both arrows only when no stream has ever been detected', async () => {
		const { container } = render(Page, {
			data: buildData({ streamCount: 0, rows: [], remainingExpenseCents: 0 })
		});

		const arrows = container.querySelectorAll('a[aria-label]');
		expect(arrows.length).toBe(2);
		for (const arrow of arrows) {
			expect(arrow.hasAttribute('href')).toBe(false);
			expect(arrow.getAttribute('aria-disabled')).toBe('true');
			expect(arrow.getAttribute('tabindex')).toBe('-1');
		}
		expect(container.textContent).toContain('Aucun flux récurrent détecté');
	});

	// B2. Detection is pinned to the 12 months before today, so a month older than
	// `oldestNavigableMonth` holds nothing AND keeps a non-zero `streamCount` — which lands on the
	// "Rien de prévu en juin 2024 · Changez de mois pour les retrouver" state: a false claim about a
	// month the user really did pay bills in, whose suggested remedy is the one action that cannot
	// help. The navigator stops at the boundary instead, with the arrow treatment the page already
	// owns; the "next" arrow is untouched, since walking forward is always meaningful.
	it('rend la flèche précédente inerte au bord de la fenêtre de détection, vivante un mois plus tard', async () => {
		const atBoundary = render(Page, {
			data: buildData({
				month: '2025-07',
				oldestNavigableMonth: '2025-07',
				isCurrentMonth: false,
				streamCount: 4,
				rows: []
			})
		});

		const [previous, next] = atBoundary.container.querySelectorAll('a[aria-label]');
		expect(previous.hasAttribute('href')).toBe(false);
		expect(previous.getAttribute('aria-disabled')).toBe('true');
		expect(previous.getAttribute('tabindex')).toBe('-1');
		expect(previous.className).toContain('pointer-events-none');
		// Only the backward arrow is bounded.
		expect(next.hasAttribute('href')).toBe(true);
		expect(next.getAttribute('aria-disabled')).toBeNull();

		atBoundary.unmount();

		const insideWindow = render(Page, {
			data: buildData({
				month: '2025-08',
				oldestNavigableMonth: '2025-07',
				isCurrentMonth: false,
				streamCount: 4,
				rows: []
			})
		});

		const [livePrevious] = insideWindow.container.querySelectorAll('a[aria-label]');
		expect(livePrevious.hasAttribute('href')).toBe(true);
		expect(livePrevious.getAttribute('aria-disabled')).toBeNull();
		expect(livePrevious.className).not.toContain('pointer-events-none');
	});

	// The STRICTLY older case, which the boundary test above cannot reach: the route redirects such a
	// month, so this state is only produced by a stale client-side navigation — but the predicate is
	// `<=`, and without this a regression to `===` would go green here and silently re-open the path
	// the redirect closes.
	it('garde la flèche précédente inerte sur un mois strictement plus ancien que la borne', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2024-06',
				oldestNavigableMonth: '2025-07',
				isCurrentMonth: false,
				streamCount: 4,
				rows: []
			})
		});

		const [previous] = container.querySelectorAll('a[aria-label]');
		expect(previous.hasAttribute('href')).toBe(false);
		expect(previous.getAttribute('aria-disabled')).toBe('true');
	});

	// I2. The whole point of the last assertion: a rowKey is built from `normalizeRecurringLabel`,
	// which collapses every non-letter run to a SPACE. HTML forbids whitespace in an `id`, and
	// aria-labelledby / aria-controls / aria-describedby are space-separated ID LISTS — so an id
	// with a space in it silently resolves to nothing when Task 8 wires focus to it.
	it('exposes the focus-target ids Task 8 needs, none of them containing whitespace', async () => {
		const ignoredRow = buildRow({
			rowKey: 'expense:salle de sport:2026-07-15:2',
			label: 'Salle de sport',
			dateIso: '2026-07-15',
			status: 'ignored',
			countsInRemainingTotal: false,
			appliedActionId: 'action-a'
		});
		const { container } = render(Page, {
			data: buildData({
				streamCount: 3,
				rows: [
					buildRow({ rowKey: 'income:salaire acme:2026-07-03:1', label: 'Salaire ACME' }),
					ignoredRow
				]
			})
		});

		const list = container.querySelector('#bills-list');
		expect(list).not.toBeNull();
		expect(list?.getAttribute('tabindex')).toBe('-1');

		const rowNodes = container.querySelectorAll('[id^="bill-row-"]');
		expect(rowNodes.length).toBe(2);
		for (const node of rowNodes) {
			expect(node.getAttribute('tabindex')).toBe('-1');
			expect(node.id).not.toMatch(/\s/);
		}

		const restoreNodes = container.querySelectorAll('[id^="bill-restore-"]');
		expect(restoreNodes.length).toBe(1);
		expect(restoreNodes[0].id).not.toMatch(/\s/);
		// Built with the exported helper, so Task 8's focus call cannot use a different regex.
		expect(restoreNodes[0].id).toBe(`bill-restore-${toBillRowDomKey(ignoredRow.rowKey)}`);
		// The source key really does carry the characters this is protecting against.
		expect(ignoredRow.rowKey).toMatch(/\s/);
	});

	// The role="list" pattern is introduced by this page and used nowhere else in the codebase, so
	// the tree is asserted rather than assumed: one list per visible group, each named by its own
	// visible heading, and one listitem per visible row.
	it('builds one role="list" per group, each labelled by its visible heading', async () => {
		const { container } = render(Page, {
			data: buildData({
				streamCount: 3,
				rows: [
					buildRow({
						rowKey: 'expense:assurance auto:2026-07-28:0',
						label: 'Assurance auto',
						dateIso: '2026-07-28',
						status: 'overdue',
						daysLate: 3
					}),
					buildRow(),
					buildRow({
						rowKey: 'income:salaire acme:2026-07-03:2',
						label: 'Salaire ACME',
						direction: 'income',
						dateIso: '2026-07-03',
						status: 'settled',
						settledKind: 'auto',
						amountCents: 320_000,
						countsInRemainingTotal: false
					})
				]
			})
		});

		const lists = container.querySelectorAll('[role="list"]');
		expect(lists.length).toBe(3);

		for (const list of lists) {
			const headingId = list.getAttribute('aria-labelledby');
			expect(headingId).toBeTruthy();
			const heading = container.querySelector(`#${headingId}`);
			expect(heading).not.toBeNull();
			expect(heading?.textContent?.trim().length).toBeGreaterThan(0);
			expect(list.querySelectorAll('[role="listitem"]').length).toBe(1);
		}

		expect(container.querySelectorAll('[role="listitem"]').length).toBe(3);
	});

	// F1 + G1, both written RED against the code of their day: the header, the settled heading and
	// the nothing-due title all branched on `isCurrentMonth` alone, so ONE click on "Période
	// précédente" rendered future-tense copy over a zero ("prévu en juin 0,00 € pour +0,00 €"); the
	// fix reached the desktop line only, and the `lg:hidden` mobile one kept saying "Reste à sortir
	// 0,00 €". Both surfaces are asserted from ONE render because `lg:hidden` is CSS — the node is in
	// the DOM, and in `textContent`, at every width.
	//
	// The zero is matched through `formatCents`, never typed out: `Intl` puts a NARROW NO-BREAK SPACE
	// (U+202F) before "€", so the hand-written literal '0,00 €' with an ASCII U+0020 could not match
	// anything and this assertion could never fail. Same fact, same workaround, as
	// UpcomingBillsCard.svelte.spec.ts.
	it('renders past-tense copy on a past month, never the future wording or a zeroed total, on EITHER surface', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2026-06',
				isCurrentMonth: false,
				isFutureMonth: false,
				streamCount: 9,
				remainingExpenseCents: 0,
				expectedIncomeCents: 0,
				rows: [
					buildRow({
						rowKey: 'expense:netflix:2026-06-30:0',
						dateIso: '2026-06-30',
						status: 'settled',
						settledKind: 'auto',
						countsInRemainingTotal: false
					})
				]
			})
		});

		const text = container.textContent ?? '';
		expect(text).not.toContain('prévu en');
		expect(text).not.toContain(formatCents(0));
		// The mobile line's own present-tense claim, gone whatever figure follows it.
		expect(text).not.toContain('Reste à sortir');
		expect(text).toContain('échéances en juin');
		expect(text).toContain('Échéances en juin');
		// "Réglées ce mois" is false on a month that is over.
		expect(text).not.toContain('Réglées ce mois');
		expect(text).toContain('Réglées en juin');
	});

	// The other half of G1: the past-month branch must not depend on the total being zero, because it
	// is not always zero. A stream that stopped months ago still projects into this period and its
	// rows come back `overdue` / `countsInRemainingTotal: true`, so `remainingExpenseCents` is real —
	// and the header still owes no "reste à sortir" claim for a period that is over.
	it('drops the present-tense header on a past month even when its remaining total is NOT zero', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2026-06',
				isCurrentMonth: false,
				isFutureMonth: false,
				streamCount: 9,
				remainingExpenseCents: 41_230,
				expectedIncomeCents: 320_000,
				rows: [
					buildRow({
						rowKey: 'expense:netflix:2026-06-30:0',
						dateIso: '2026-06-30',
						status: 'overdue',
						daysLate: 31
					})
				]
			})
		});

		const text = container.textContent ?? '';
		expect(text).not.toContain('Reste à sortir');
		expect(text).not.toContain('reste à sortir');
		expect(text).not.toContain('prévu en');
		expect(text).toContain('Échéances en juin');
	});

	// The page half of `formatAmountRangeBounds`: only the widget's use of the shared helper is
	// exercised today. Asserted on a PAST month, where the row still has to render its bounds.
	it('prints a variable amount as a range with one currency symbol, on a past month too', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2026-06',
				isCurrentMonth: false,
				isFutureMonth: false,
				streamCount: 2,
				remainingExpenseCents: 0,
				rows: [
					buildRow({
						rowKey: 'expense:edf:2026-06-15:0',
						label: 'EDF',
						dateIso: '2026-06-15',
						status: 'settled',
						settledKind: 'auto',
						countsInRemainingTotal: false,
						amountCents: -7_400,
						averageAmountCents: 8_500,
						minAmountCents: 7_400,
						maxAmountCents: 9_600,
						variability: 'variable'
					})
				]
			})
		});

		const { min, max } = formatAmountRangeBounds(7_400, 9_600, '−', 'fr');
		const text = container.textContent ?? '';
		// Built through the helper, not typed: fr's grouping and currency spaces are non-ASCII.
		expect(text).toContain(`${min} à ${max}`);
		// The symbol appears once in the range; the sign is on both bounds.
		expect(min).not.toContain('€');
		expect(max).toContain('€');
		expect(min.startsWith('−')).toBe(true);
		expect(max.startsWith('−')).toBe(true);
	});

	it('titles an empty past month without claiming anything is still expected', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2026-06',
				isCurrentMonth: false,
				isFutureMonth: false,
				streamCount: 4,
				remainingExpenseCents: 0,
				rows: []
			})
		});

		const text = container.textContent ?? '';
		expect(text).not.toContain('Rien de prévu en');
		expect(text).toContain('Aucune échéance en juin');
	});

	// The future month keeps the wording the design specifies for it (plate B2).
	it('keeps the future wording on a future month', async () => {
		const { container } = render(Page, {
			data: buildData({
				month: '2026-08',
				isCurrentMonth: false,
				isFutureMonth: true,
				streamCount: 9,
				remainingExpenseCents: 41_230,
				expectedIncomeCents: 320_000,
				rows: [buildRow({ rowKey: 'expense:netflix:2026-08-31:0', dateIso: '2026-08-31' })]
			})
		});

		expect(container.textContent).toContain('prévu en août');
	});

	// ─── Row actions ──────────────────────────────────────────────────────────

	/** Locked decision: exactly these four, in this order, on both surfaces. */
	const LOCKED_ACTIONS = [
		'Marquer comme payée',
		'Ignorer cette occurrence',
		'Voir les transactions liées',
		'Ne plus détecter ce flux'
	];

	function isRose(element: Element): boolean {
		return element.className.includes('text-rose-600');
	}

	it('renders exactly the four locked actions, in order, in the desktop row menu, only the last in rose', async () => {
		// The desktop cell is `hidden lg:grid`; the suite's beforeEach already puts the viewport at
		// 1280 so its trigger is not display:none and a role-based query can reach it.
		render(Page, { data: buildData() });

		// Named per row, not "Actions de l'échéance": a page of them would otherwise expose several
		// controls sharing one accessible name.
		const trigger = page.getByRole('button', { name: 'Actions pour Netflix' });
		await expect.element(trigger).toBeInTheDocument();
		await userEvent.click(trigger);

		// Bits UI portals the panel out of the render container, so this reads the document.
		const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
		expect(items.map((item) => item.textContent?.trim())).toEqual(LOCKED_ACTIONS);
		expect(items.filter(isRose).length).toBe(1);
		expect(isRose(items[3])).toBe(true);

		// The third is a real link to the transactions page, filtered by the label that actually
		// matches the stored transactions (the raw one), never the anonymized display form.
		expect(items[2].getAttribute('href')).toBe(
			`/transactions?q=${encodeURIComponent('NETFLIX.COM')}`
		);
	});

	it('opens the mobile action sheet from the row, with the same four actions in the same order', async () => {
		// 390px, design planche C1. Set explicitly because the viewport is shared across tests in a
		// file and the desktop menu test above widens it.
		await page.viewport(390, 844);
		const { container } = render(Page, { data: buildData() });

		// One focusable control per mobile row (design C1), distinguished from the desktop cell by
		// its breakpoint class rather than by its text.
		const rowButton = [...container.querySelectorAll('button')].find((button) =>
			button.className.includes('lg:hidden')
		);
		expect(rowButton).toBeTruthy();
		await userEvent.click(rowButton!);

		const sheet = document.querySelector('[role="dialog"][aria-label="Netflix"]');
		expect(sheet).not.toBeNull();
		// The sheet's own header line: date · amount · lateness.
		expect(sheet?.textContent).toContain('Attendue le');

		// Enumerated structurally, NOT filtered down to the expected labels first: filtering would
		// make a fifth action — including a rose one — invisible to this assertion and to the rose
		// count computed from it. BottomSheet's only other interactive-looking chrome is its drag
		// handle, which is a div, so every button/anchor inside the sheet is one of the row's own
		// actions and a fifth would show up here.
		const items = [...(sheet?.querySelectorAll('button, a') ?? [])];
		expect(items.map((item) => item.textContent?.trim())).toEqual(LOCKED_ACTIONS);
		expect(items.filter(isRose).length).toBe(1);
		expect(isRose(items[3])).toBe(true);
		// 52px, above the 44px minimum (design C2).
		for (const item of items) expect(item.className).toContain('min-h-[52px]');
	});

	it('gives a settled row no action surface at all, and an ignored row only its restore link', async () => {
		const { container } = render(Page, {
			data: buildData({
				streamCount: 2,
				rows: [
					buildRow({
						rowKey: 'income:salaire acme:2026-07-03:0',
						label: 'Salaire ACME',
						direction: 'income',
						dateIso: '2026-07-03',
						status: 'settled',
						settledKind: 'auto',
						amountCents: 320_000,
						countsInRemainingTotal: false
					}),
					buildRow({
						rowKey: 'expense:salle de sport:2026-07-15:1',
						label: 'Salle de sport',
						dateIso: '2026-07-15',
						status: 'ignored',
						countsInRemainingTotal: false,
						appliedActionId: 'action-a'
					})
				]
			})
		});

		expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull();
		expect(container.textContent).not.toContain('Marquer payé');

		// The restore link is a real submit control now, not the disabled placeholder Task 7 shipped.
		const restore = container.querySelector<HTMLButtonElement>('[id^="bill-restore-"]');
		expect(restore).not.toBeNull();
		expect(restore?.tagName).toBe('BUTTON');
		expect(restore?.getAttribute('type')).toBe('submit');
		expect(restore?.disabled).toBe(false);
		expect(restore?.closest('form')?.getAttribute('action')).toBe('?/undoAction');
	});

	it('posts the stored payload without normalizedLabel', async () => {
		const { container } = render(Page, { data: buildData() });

		const form = container.querySelector<HTMLFormElement>('form[action="?/markPaid"]');
		expect(form).not.toBeNull();
		const names = [...form!.querySelectorAll('input[type="hidden"]')].map((input) =>
			input.getAttribute('name')
		);
		// The server recomputes it from the label it stores and the field was removed from the input
		// type, so posting it would be a value silently ignored.
		expect(names).not.toContain('normalizedLabel');
		expect(names).toEqual([
			'direction',
			'label',
			'displayLabel',
			'anchorTransactionIds',
			'dueDate'
		]);
		expect(form!.querySelector('input[name="label"]')?.getAttribute('value')).toBe('NETFLIX.COM');
	});

	it('announces a successful action in a polite live region and offers the undo', async () => {
		const { container } = render(Page, {
			data: buildData(),
			form: { billAction: { kind: 'ignore', actionId: 'action-1', month: '2026-07', label: '' } }
		});

		const banner = container.querySelector('[role="status"][aria-live="polite"]');
		expect(banner).not.toBeNull();
		expect(banner?.textContent).toContain('Échéance ignorée pour juillet 2026');

		// The undo posts through a form OUTSIDE the banner: AlertBanner renders a <p>, and a <form>
		// start tag would close it in the HTML parser.
		const undo = [...(banner?.querySelectorAll('button') ?? [])].find(
			(button) => button.textContent?.trim() === 'Annuler'
		);
		expect(undo?.getAttribute('form')).toBe('bill-undo-banner');
		expect(banner?.querySelector('form')).toBeNull();
		expect(container.querySelector('#bill-undo-banner')?.getAttribute('action')).toBe(
			'?/undoAction'
		);
	});

	// ─── Focus after a mutation lands in the COLLAPSED settled group ──────────
	//
	// Written red first. Both "ignorer" and "marquer payée" move the row into the settled group,
	// which renders only its first SETTLED_COLLAPSED_ROWS rows — design plate B1's own month is
	// "Réglées ce mois · 5". Past that cut the focus target is never rendered, `getElementById`
	// returns null and the optional call no-ops, so focus silently falls to <body>. The page now
	// expands the group before moving focus; without that, both assertions below report BODY.

	/** Four already-settled rows, so anything joining them lands past the collapse cut. */
	function settledFillers(): UpcomingBillRowView[] {
		return [0, 1, 2, 3].map((index) =>
			buildRow({
				rowKey: `expense:filler ${index}:2026-07-0${index + 1}:${index}`,
				label: `Filler ${index}`,
				dateIso: `2026-07-0${index + 1}`,
				status: 'settled',
				settledKind: 'auto',
				countsInRemainingTotal: false
			})
		);
	}

	const NETFLIX_DOM_KEY = toBillRowDomKey(buildRow().rowKey);

	it('moves focus to the restore link after an ignore, even when the row lands past the settled cut', async () => {
		const before = buildData({ streamCount: 5, rows: [...settledFillers(), buildRow()] });
		const after = buildData({
			streamCount: 5,
			rows: [
				...settledFillers(),
				buildRow({ status: 'ignored', countsInRemainingTotal: false, appliedActionId: 'action-1' })
			]
		});
		const { rerender } = render(Page, { data: before });

		// Through the real surface: the menu item is what opens the dialog whose form is enhanced.
		await userEvent.click(page.getByRole('button', { name: 'Actions pour Netflix' }));
		await userEvent.click(page.getByRole('menuitem', { name: 'Ignorer cette occurrence' }));

		// `update()` is the server round trip: it swaps in the post-mutation data, which also makes
		// the period effect fire for real — that effect resets the expansion flag, and the order it
		// runs in relative to the focus move is precisely what this pins.
		await runSubmit('?/ignoreOccurrence', async () => {
			await rerender({ data: after });
		});

		expect(document.activeElement?.id).toBe(`bill-restore-${NETFLIX_DOM_KEY}`);
		expect(document.activeElement?.tagName).not.toBe('BODY');
	});

	it('moves focus to the row container after a mark paid, even when the row lands past the settled cut', async () => {
		const before = buildData({ streamCount: 5, rows: [...settledFillers(), buildRow()] });
		const after = buildData({
			streamCount: 5,
			rows: [
				...settledFillers(),
				buildRow({ status: 'settled', settledKind: 'manual', countsInRemainingTotal: false })
			]
		});
		const { rerender } = render(Page, { data: before });

		await runSubmit('?/markPaid', async () => {
			await rerender({ data: after });
		});

		expect(document.activeElement?.id).toBe(`bill-row-${NETFLIX_DOM_KEY}`);
		expect(document.activeElement?.tagName).not.toBe('BODY');
	});

	// ─── The two confirmation dialogs ─────────────────────────────────────────

	/** Opens a row menu item that leads to a ConfirmDialog. */
	async function openDialogItem(name: string) {
		await userEvent.click(page.getByRole('button', { name: 'Actions pour Netflix' }));
		await userEvent.click(page.getByRole('menuitem', { name }));
	}

	function confirmButton(container: HTMLElement, label: string): HTMLButtonElement {
		const button = [...container.querySelectorAll('button')].find(
			(candidate) => candidate.textContent?.trim() === label
		);
		expect(button).toBeTruthy();
		return button as HTMLButtonElement;
	}

	it('confirms an ignore with the design copy, a BLACK final button, and a form posting ?/ignoreOccurrence', async () => {
		const { container } = render(Page, { data: buildData() });
		await openDialogItem('Ignorer cette occurrence');

		expect(container.textContent).toContain('Ignorer cette occurrence ?');
		// The reappearance clause was dropped: the cadence can be quarterly or yearly, and naming a
		// return month would be a claim the copy cannot keep for five cadences.
		expect(container.textContent).toContain(
			"« Netflix » ne sera pas comptée pour juillet 2026. Le rythme détecté n'est pas modifié."
		);
		expect(container.textContent).not.toContain('réapparaîtra');

		const confirm = confirmButton(container, 'Ignorer pour juillet');
		// Locked design point: ignoring is reversible and local to one period, so the final button is
		// the default black — never the rose reserved for the destructive action.
		expect(confirm.className).toContain('bg-zinc-950');
		expect(confirm.className).not.toContain('bg-rose-600');

		// `button.form` is the browser's own form-association resolution, so this fails the day the
		// button stops being inside (or associated with) the wrapping form — the whole-feature-dead
		// mode a Modal gaining a portal would introduce.
		expect(confirm.type).toBe('submit');
		expect(confirm.form?.getAttribute('action')).toBe('?/ignoreOccurrence');
		expect(confirm.form?.querySelector('input[name="dueDate"]')?.getAttribute('value')).toBe(
			TODAY_ISO
		);
	});

	it('confirms an exclude in ROSE, with a form posting ?/excludeStream and carrying no due date', async () => {
		const { container } = render(Page, { data: buildData() });
		await openDialogItem('Ne plus détecter ce flux');

		expect(container.textContent).toContain('Ne plus détecter ce flux ?');
		expect(container.textContent).toContain(
			'« Netflix » ne sera plus suivi dans les échéances. Vos transactions existantes ne sont pas modifiées.'
		);

		const confirm = confirmButton(container, 'Ne plus détecter');
		// The one destructive action, and the only rose one.
		expect(confirm.className).toContain('bg-rose-600');
		expect(confirm.className).not.toContain('bg-zinc-950');

		expect(confirm.type).toBe('submit');
		expect(confirm.form?.getAttribute('action')).toBe('?/excludeStream');
		// An exclude targets the whole stream; the service refuses one carrying a due date, so the
		// field must be absent rather than empty.
		expect(confirm.form?.querySelector('input[name="dueDate"]')).toBeNull();
	});

	it('does not show a previous action failure inside a freshly opened dialog', async () => {
		const { container } = render(Page, {
			data: buildData(),
			form: { billError: 'Échéance introuvable ou déjà obsolète. Rechargez la page.' }
		});
		expect(container.textContent).toContain('Échéance introuvable');

		await openDialogItem('Ignorer cette occurrence');

		// The message belonged to the mark-paid that failed, not to this confirmation.
		expect(container.textContent).not.toContain('Échéance introuvable');
	});

	// ─── The excluded-streams escape hatch (B3-b) ─────────────────────────────
	//
	// "Ne plus détecter ce flux" removes the stream from every list, so before this section the
	// decision was invisible and therefore permanent in practice.

	const EXCLUDED = [
		{ actionId: 'action-x', label: 'Netflix', initials: 'NF' },
		{ actionId: 'action-y', label: 'Spotify', initials: 'SP' }
	];

	it('lists excluded streams in a section collapsed by default, restorable through ?/undoAction', async () => {
		const { container } = render(Page, { data: buildData({ excludedStreams: EXCLUDED }) });

		const toggle = container.querySelector<HTMLButtonElement>('#bills-excluded-toggle');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(toggle?.textContent).toContain('Détection désactivée · 2');

		const list = container.querySelector<HTMLElement>('#bills-excluded-list');
		// Collapsed but PRESENT: `aria-controls` must resolve to a real element in both states, and a
		// removed node resolves to nothing.
		expect(toggle?.getAttribute('aria-controls')).toBe('bills-excluded-list');
		expect(list?.hidden).toBe(true);
		// Same read structure as the bill groups above: a named list of listitems.
		expect(list?.getAttribute('role')).toBe('list');
		expect(list?.getAttribute('aria-labelledby')).toBe('bills-excluded-heading');
		expect(container.querySelector('#bills-excluded-heading')).not.toBeNull();

		await userEvent.click(page.getByRole('button', { name: /Détection désactivée/ }));
		expect(toggle?.getAttribute('aria-expanded')).toBe('true');
		expect(list?.hidden).toBe(false);

		// The restore reuses the EXISTING undo action; no second endpoint was added for it.
		const forms = [...(list?.querySelectorAll('form') ?? [])];
		expect(forms.map((form) => form.getAttribute('action'))).toEqual([
			'?/undoAction',
			'?/undoAction'
		]);
		expect(forms[0].querySelector('input[name="actionId"]')?.getAttribute('value')).toBe(
			'action-x'
		);
		// "Rétablir" alone would name both rows identically.
		expect(forms[0].textContent).toContain('Rétablir la détection de Netflix');
		expect(forms[1].textContent).toContain('Rétablir la détection de Spotify');
	});

	it('collapses again on a second toggle', async () => {
		const { container } = render(Page, { data: buildData({ excludedStreams: EXCLUDED }) });
		const toggle = container.querySelector<HTMLButtonElement>('#bills-excluded-toggle');
		const list = container.querySelector<HTMLElement>('#bills-excluded-list');

		await userEvent.click(page.getByRole('button', { name: /Détection désactivée/ }));
		expect(toggle?.getAttribute('aria-expanded')).toBe('true');

		// Only the opening direction was covered; a toggle that latches open is a real bug shape.
		await userEvent.click(page.getByRole('button', { name: /Détection désactivée/ }));
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(list?.hidden).toBe(true);
	});

	it('is the section heading, so it appears in the page heading outline', () => {
		const { container } = render(Page, { data: buildData({ excludedStreams: EXCLUDED }) });

		// A bare <button> would leave the section out of the outline entirely, unlike every bill group.
		const heading = container.querySelector('h2 > #bills-excluded-toggle');
		expect(heading).not.toBeNull();
	});

	/**
	 * The moment this escape hatch matters most: excluding the only detected stream drives
	 * `streamCount` to 0, which puts the page in its "nothing has ever been detected" empty state.
	 * The section is a sibling of `#bills-list` rather than a child, so it survives that branch — but
	 * that is a claim about markup placement and nothing else covered it.
	 */
	it('still renders the excluded section in the no-stream-at-all empty state', () => {
		const { container } = render(Page, {
			data: buildData({ streamCount: 0, rows: [], excludedStreams: [EXCLUDED[0]] })
		});

		expect(container.textContent).toContain('Le moteur observe encore');
		expect(container.querySelector('#bills-excluded-toggle')).not.toBeNull();
		expect(container.textContent).toContain('Détection désactivée · 1');
	});

	/**
	 * F1: the cap counts EVERY kind, so it is reachable with zero exclusions (40 streams × 12 months
	 * of ignores is 480, all still live). The copy must therefore not rest on a section that is not
	 * on the page in that exact case.
	 */
	it('states the cap error truthfully when no excluded section is rendered', () => {
		const { container } = render(Page, {
			data: buildData({ excludedStreams: [] }),
			form: { billError: m.upcoming_bills_error_action_limit() }
		});

		expect(container.querySelector('#bills-excluded-toggle')).toBeNull();
		const banner = container.querySelector('[role="alert"]');
		// The unconditional half: always true, whether or not the user holds an exclusion.
		expect(banner?.textContent).toContain('Les plus anciennes sont supprimées automatiquement');
		// The section is offered only for the case where it exists, never as the required action.
		expect(banner?.textContent).toContain('pour un flux exclu');
		expect(banner?.textContent).not.toContain("Annulez-en une avant d'en ajouter une nouvelle");
	});

	it('renders no excluded section at all when the user holds no exclusion', () => {
		const { container } = render(Page, { data: buildData() });

		expect(container.querySelector('#bills-excluded-toggle')).toBeNull();
		expect(container.textContent).not.toContain('Détection désactivée');
	});

	it('moves focus to the list when the last exclusion is restored', async () => {
		const before = buildData({ excludedStreams: [EXCLUDED[0]] });
		const after = buildData();
		const { rerender } = render(Page, { data: before });

		// The section disappears with its last row, so the focus target chosen at render is the list —
		// not the toggle, which is exactly the node that has just been removed.
		await runSubmit('?/undoAction', async () => {
			await rerender({ data: after });
		});

		expect(document.activeElement?.id).toBe('bills-list');
		expect(document.activeElement?.tagName).not.toBe('BODY');
	});

	it('keeps focus on the toggle when an exclusion remains', async () => {
		const before = buildData({ excludedStreams: EXCLUDED });
		const after = buildData({ excludedStreams: [EXCLUDED[1]] });
		const { rerender } = render(Page, { data: before });

		const first = submitted.filter((entry) => entry.node.getAttribute('action') === '?/undoAction');
		expect(first).toHaveLength(2);
		const callback = first[0].submit({} as Parameters<SubmitFunction>[0]);
		if (typeof callback !== 'function') throw new Error('submit function returned no callback');
		await callback({
			result: { type: 'success', status: 200 },
			update: async () => {
				await rerender({ data: after });
			}
		} as unknown as Parameters<Exclude<Awaited<ReturnType<SubmitFunction>>, void>>[0]);

		expect(document.activeElement?.id).toBe('bills-excluded-toggle');
	});

	it('surfaces an action failure as an error banner rather than a success one', async () => {
		const { container } = render(Page, {
			data: buildData(),
			form: { billError: 'Décision introuvable.' }
		});

		const banner = container.querySelector('[role="alert"]');
		expect(banner?.textContent).toContain('Décision introuvable.');
		expect(container.querySelector('[role="status"][aria-live="polite"]')).toBeNull();
	});
});
