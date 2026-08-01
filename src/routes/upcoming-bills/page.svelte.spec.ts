import { describe, it, expect } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import { toBillRowDomKey } from '$lib/domain/upcomingBills';
import type { UpcomingBillRowView } from '$lib/server/upcoming-bills/service';
import type { PageData } from './$types';

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
			streamCount: 1,
			remainingExpenseCents: 1349,
			expectedIncomeCents: 0,
			rows: [buildRow()],
			observationCandidates: [],
			...overrides
		}
	} as PageData;
}

describe('/upcoming-bills page', () => {
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
		// The desktop cell is `hidden lg:grid`, so at a narrower viewport its trigger is display:none
		// and no role-based query can reach it. Widened here rather than queried around it: the
		// subject of this test IS the desktop surface.
		await page.viewport(1280, 900);
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

		const items = [...(sheet?.querySelectorAll('button, a') ?? [])].filter((item) =>
			LOCKED_ACTIONS.includes(item.textContent?.trim() ?? '')
		);
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

	it('posts the stored payload without normalizedLabel, and omits the due date on an exclude', async () => {
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
