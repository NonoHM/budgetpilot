import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../routes/layout.css';
import UpcomingBillsCard from './UpcomingBillsCard.svelte';
import { formatCents } from '$lib/domain/budget';
import { formatShortDate } from '$lib/domain/dateFormat';
import type {
	UpcomingBillRowView,
	UpcomingBillsWidgetView
} from '$lib/server/upcoming-bills/service';

const TODAY_ISO = '2026-08-01';

function buildRow(overrides: Partial<UpcomingBillRowView> = {}): UpcomingBillRowView {
	return {
		rowKey: 'expense:edf:2026-08-05:0',
		label: 'EDF',
		initials: 'ED',
		category: 'Logement',
		direction: 'expense',
		tier: 'confirmed',
		occurrenceCount: 6,
		cadence: 'monthly',
		anchorDayOfMonth: 5,
		dateIso: '2026-08-05',
		status: 'upcoming',
		daysLate: null,
		estimatePassed: false,
		settledKind: null,
		amountCents: -4500,
		averageAmountCents: 4500,
		minAmountCents: 4400,
		maxAmountCents: 4600,
		variability: 'fixed',
		countsInRemainingTotal: true,
		appliedActionId: null,
		actionPayload: {
			direction: 'expense',
			normalizedLabel: 'edf',
			label: 'EDF',
			dueDate: '2026-08-05',
			anchorTransactionIds: '[]'
		},
		...overrides
	};
}

function buildWidget(overrides: Partial<UpcomingBillsWidgetView> = {}): UpcomingBillsWidgetView {
	return {
		rows: [buildRow()],
		overdueCount: 0,
		remainingExpenseCents: 4500,
		hasStreams: true,
		todayIso: TODAY_ISO,
		...overrides
	};
}

// Mirrors the component's own formatting, so an assertion pins the exact string it renders rather
// than a hand-copied one that could silently drift from a real run (narrow no-break space around
// the thousands separator, non-break space before the currency symbol, U+2212 minus).
function signedFixed(cents: number): string {
	return `${cents >= 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

function wholeEuros(magnitudeCents: number): string {
	return new Intl.NumberFormat('fr', {
		style: 'currency',
		currency: 'EUR',
		maximumFractionDigits: 0
	}).format(magnitudeCents / 100);
}

/** Same, minus the currency symbol (and the non-break space that only exists for it): the range
 *  prints the symbol ONCE, on the bound `fr` puts it next to — the upper one (design B1,
 *  "−74 à −96 €"). Written out here rather than imported so the assertion still pins a string. */
function wholeEurosBare(magnitudeCents: number): string {
	return new Intl.NumberFormat('fr', {
		style: 'currency',
		currency: 'EUR',
		maximumFractionDigits: 0
	})
		.formatToParts(magnitudeCents / 100)
		.filter((part) => part.type !== 'currency' && part.type !== 'literal')
		.map((part) => part.value)
		.join('');
}

// Catches every Tailwind shape that hides an element, not just the `max-lg:hidden` one the
// original regex happened to check for: a bare `hidden` (as in the mobile-first `hidden lg:flex`
// idiom), any breakpoint/arbitrary variant of `hidden` (`lg:hidden`, `2xl:hidden`,
// `max-[900px]:hidden`), and the two other hiding utilities (`invisible`, `sr-only`) in either
// bare or variant form.
function hasHidingToken(className: string | null | undefined): boolean {
	if (!className) return false;
	return className
		.split(/\s+/)
		.filter(Boolean)
		.some((token) => {
			const utility = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
			return utility === 'hidden' || utility === 'invisible' || utility === 'sr-only';
		});
}

describe('UpcomingBillsCard.svelte', () => {
	it('always renders the footer label, visibly, on a narrow (mobile) viewport', async () => {
		await page.viewport(390, 844);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget() });

		// Real stylesheet is loaded (see the `layout.css` import above), so `toBeVisible()` reflects
		// an actual computed style here, not an inert assertion against unstyled markup.
		await expect.element(page.getByText('Reste à sortir · 30 prochains jours')).toBeVisible();

		const footer = container.querySelector('.border-t.border-zinc-100');
		expect(footer).not.toBeNull();
		expect(hasHidingToken(footer?.className)).toBe(false);
	});

	it('always renders the footer label, visibly, on a wide (desktop) viewport', async () => {
		await page.viewport(1280, 800);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget() });

		await expect.element(page.getByText('Reste à sortir · 30 prochains jours')).toBeVisible();

		const footer = container.querySelector('.border-t.border-zinc-100');
		expect(footer).not.toBeNull();
		expect(hasHidingToken(footer?.className)).toBe(false);
	});

	it('renders the overdue badge only when overdueCount > 0', async () => {
		const { unmount } = render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 2 }) });

		await expect.element(page.getByText('2 en retard')).toBeInTheDocument();
		unmount();

		render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 0 }) });

		expect(page.getByText(/en retard/).elements().length).toBe(0);
	});

	it('carries the amber contrast classes on an overdue row and none on a non-overdue row', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				overdueCount: 1,
				rows: [
					buildRow({
						rowKey: 'overdue-row',
						status: 'overdue',
						daysLate: 3,
						dateIso: '2026-07-29'
					}),
					buildRow({ rowKey: 'upcoming-row', status: 'upcoming', dateIso: '2026-08-05' })
				]
			})
		});

		const amberRows = container.querySelectorAll(
			'[class*="bg-amber-50"][class*="border-amber-200"]'
		);
		expect(amberRows.length).toBe(1);
		expect(container.querySelector('.text-amber-700')).not.toBeNull();
	});

	it('writes the overdue lateness as text', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				overdueCount: 1,
				rows: [
					buildRow({ rowKey: 'overdue-row', status: 'overdue', daysLate: 3, dateIso: '2026-07-29' })
				]
			})
		});

		await expect.element(page.getByText('3 j de retard')).toBeInTheDocument();
	});

	it('renders the EmptyState, keeps the card title and hides the footer when no stream was ever detected', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [],
				overdueCount: 0,
				hasStreams: false,
				remainingExpenseCents: 0
			})
		});

		await expect.element(page.getByText('Échéances à venir')).toBeInTheDocument();
		await expect.element(page.getByText('Aucun flux détecté')).toBeInTheDocument();
		// No total exists in this state, so nothing should conflict with the neighbouring forecast
		// card's — the footer (and its second link to the same page) must not render (design A3).
		expect(page.getByText('Reste à sortir · 30 prochains jours').elements().length).toBe(0);
		expect(container.querySelectorAll('a[href="/upcoming-bills"]').length).toBe(1);
	});

	it('renders a different empty state, still without a footer, when streams exist but none survive into the window', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [], overdueCount: 0, hasStreams: true, remainingExpenseCents: 0 })
		});

		await expect.element(page.getByText('Échéances à venir')).toBeInTheDocument();
		await expect
			.element(page.getByText('Rien de prévu dans les 30 prochains jours.'))
			.toBeInTheDocument();
		// Must NOT reuse the "nothing detected" copy — streams WERE detected, just none are due.
		expect(page.getByText('Aucun flux détecté').elements().length).toBe(0);
		expect(page.getByText('Reste à sortir · 30 prochains jours').elements().length).toBe(0);
	});

	it('hides rows past index 2 below lg and keeps the first 3 visible on both breakpoints', async () => {
		const rows = Array.from({ length: 5 }, (_, index) =>
			buildRow({
				rowKey: `row-${index}`,
				label: `Flux ${index}`,
				dateIso: `2026-08-0${index + 1}`
			})
		);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget({ rows }) });

		const rowEls = container.querySelectorAll('.divide-y > div');
		expect(rowEls.length).toBe(5);
		rowEls.forEach((row, index) => {
			if (index >= 3) {
				expect(row.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
			} else {
				expect(row.className).not.toMatch(/(^|\s)max-lg:hidden(\s|$)/);
			}
		});
	});

	it('never re-totals: the displayed total is the server-supplied remainingExpenseCents, even when it contradicts the row amounts', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [buildRow({ amountCents: -100, minAmountCents: 100, maxAmountCents: 100 })],
				// Deliberately does not match the single row's amount: proves the component reads this
				// field rather than summing `rows` itself.
				remainingExpenseCents: 999_900
			})
		});

		await expect.element(page.getByText(signedFixed(-999_900))).toBeInTheDocument();
	});

	it('renders "0,00 €" rather than "-0,00 €" when nothing is due', async () => {
		render(UpcomingBillsCard, { widget: buildWidget({ remainingExpenseCents: 0 }) });

		await expect.element(page.getByText(formatCents(0))).toBeInTheDocument();
		expect(page.getByText('-0,00 €').elements().length).toBe(0);
		expect(page.getByText('−0,00 €').elements().length).toBe(0);
	});

	it('signs a fixed-amount expense row with a minus and an income row with a plus', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({ rowKey: 'expense', direction: 'expense', amountCents: -4890 }),
					buildRow({ rowKey: 'income', direction: 'income', amountCents: 320_000 })
				]
			})
		});

		await expect.element(page.getByText(signedFixed(-4890))).toBeInTheDocument();
		await expect.element(page.getByText(signedFixed(320_000))).toBeInTheDocument();
	});

	it('renders a variable row as a signed, euro-rounded range plus the "variable" tag', async () => {
		// Unsigned magnitudes in cents, as `forecast.ts` documents them.
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({
						rowKey: 'variable-row',
						direction: 'expense',
						amountCents: -8000,
						variability: 'variable',
						minAmountCents: 7412,
						maxAmountCents: 9587
					})
				]
			})
		});

		// Signed AND rounded to whole euros — not "74,12 € à 95,87 €", which would carry no sign and a
		// false precision (F1).
		await expect
			.element(page.getByText(`−${wholeEurosBare(7412)} à −${wholeEuros(9587)}`))
			.toBeInTheDocument();
		await expect.element(page.getByText('variable')).toBeInTheDocument();
	});

	it('renders a variable income row as a signed positive range', async () => {
		// Only the expense variable row was previously covered — signing is the entire reason
		// `formatSignedRange` exists, so an income row is the case most likely to regress silently.
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({
						rowKey: 'variable-income',
						direction: 'income',
						amountCents: 8500,
						variability: 'variable',
						minAmountCents: 7400,
						maxAmountCents: 9600
					})
				]
			})
		});

		await expect
			.element(page.getByText(`+${wholeEurosBare(7400)} à +${wholeEuros(9600)}`))
			.toBeInTheDocument();
	});

	it('derives relative-date text from widget.todayIso, never from the browser clock', async () => {
		// todayIso is deliberately years away from the real wall clock: a `new Date()`-based
		// implementation could not produce "dans 3 j" for a row dated 2020-03-04 under this fixture.
		render(UpcomingBillsCard, {
			widget: buildWidget({
				todayIso: '2020-03-01',
				rows: [buildRow({ rowKey: 'row', dateIso: '2020-03-04' })]
			})
		});

		await expect.element(page.getByText('dans 3 j')).toBeInTheDocument();
	});

	it('composes the sub-line as absolute date, then a separator, then the relative label, for a future row', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				// TODAY_ISO is 2026-08-01, so this row is 3 days out — clear of the delta===1 "demain"
				// special case, so the general "dans N j" composition is what's under test here.
				rows: [buildRow({ rowKey: 'row', dateIso: '2026-08-04' })]
			})
		});

		const subLine = container.querySelector('.min-w-0.flex-1 > div.text-xs');
		expect(subLine?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
			`${formatShortDate('2026-08-04', 'fr')} · dans 3 j`
		);
	});

	it('renders "aujourd\'hui" alone, with no date part, for a row due today', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [buildRow({ rowKey: 'row', dateIso: TODAY_ISO })] })
		});

		const subLine = container.querySelector('.min-w-0.flex-1 > div.text-xs');
		expect(subLine?.textContent?.trim()).toBe("aujourd'hui");
	});

	it('carries proximity as weight, not colour: near-horizon rows are dark and bold, far-horizon rows are neither', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({ rowKey: 'near', dateIso: '2026-08-08' }), // delta 7: at the near threshold
					buildRow({ rowKey: 'far', dateIso: '2026-08-09' }) // delta 8: just past it
				]
			})
		});

		const [nearRow, farRow] = container.querySelectorAll('.divide-y > div');
		const nearDate = nearRow.querySelector('.text-xs span:first-child');
		const nearRelative = nearRow.querySelector('.text-xs span:last-child');
		expect(nearDate?.className).toContain('text-zinc-900');
		expect(nearRelative?.className).toContain('font-bold');
		expect(nearRelative?.className).toContain('text-zinc-700');

		const farDate = farRow.querySelector('.text-xs span:first-child');
		const farRelative = farRow.querySelector('.text-xs span:last-child');
		expect(farDate?.className).toContain('text-zinc-500');
		expect(farRelative?.className).not.toContain('font-bold');
		expect(farRelative?.className).toContain('text-zinc-400');
	});

	it('renders an icon in both "no streams" and "streams but none due" empty states', async () => {
		const { container: noStreams, unmount } = render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [],
				overdueCount: 0,
				hasStreams: false,
				remainingExpenseCents: 0
			})
		});
		expect(noStreams.querySelector('svg')).not.toBeNull();
		unmount();

		const { container: noneDue } = render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [], overdueCount: 0, hasStreams: true, remainingExpenseCents: 0 })
		});
		expect(noneDue.querySelector('svg')).not.toBeNull();
	});

	it('gives the last mobile-visible row (index 2) max-lg:pb-0 and the last row overall (index 4) pb-0, with 5 rows', async () => {
		const rows = Array.from({ length: 5 }, (_, index) =>
			buildRow({ rowKey: `row-${index}`, label: `Flux ${index}`, dateIso: `2026-08-0${index + 2}` })
		);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget({ rows }) });

		const rowEls = container.querySelectorAll('.divide-y > div');
		expect(rowEls[2].className).toMatch(/(^|\s)max-lg:pb-0(\s|$)/);
		expect(rowEls[2].className).not.toMatch(/(^|\s)pb-0(\s|$)/);
		expect(rowEls[4].className).toMatch(/(^|\s)pb-0(\s|$)/);
	});
});
