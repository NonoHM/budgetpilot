import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import NetWorthChart from './NetWorthChart.svelte';

/**
 * #204: the chart announced a time on a snapshot that carries none.
 *
 * **The issue's stated mechanism is wrong and the correction matters, because it changes what the
 * fix has to be.** It reads « the 14:00 is UTC midnight rendered in local time ». Midnight UTC on
 * 1 May renders as 02:00 **AM** in Europe/Paris; the string the issue itself measured is
 * « May 1, 2026, 02:00 PM ». That is **noon** UTC — and noon UTC is exactly what
 * `parseAsOfDate` writes (`net-worth/service.ts:373`, `new Date(\`${raw}T12:00:00.000Z\`)`) for a
 * backdated snapshot whose input is a plain `YYYY-MM-DD`. So the 14:00 is a **sentinel meaning
 * "no time"**, not a timezone artefact.
 *
 * **And `capturedAt` is genuinely mixed.** A snapshot saved without a date gets `new Date()`
 * (`service.ts:355`) and a synced one gets the provider's instant
 * (`recordSyncedBalance`) — both real moments. So there is no test that separates
 * "fabricated time" from "real time" at render, and any conditional on the sentinel instant is a
 * magic-value check that goes wrong the day the sentinel moves.
 *
 * The chart therefore renders the DAY at every one of its four sites. The unit of this screen is
 * the day: the axis labels are already date-only, and a time that is invented on a backdated
 * snapshot and true on an immediate one, with nothing distinguishing them, cannot be read as true
 * by anyone.
 *
 * **The issue is also wrong that only screen-reader users see it.** `formatFullDate` fed the
 * sr-only table, the point `aria-label`, the SVG `<title>` AND the visible hover tooltip.
 *
 * The assertions below are timezone-independent on purpose — they assert the ABSENCE of a clock
 * time rather than a particular rendered string, so the runner's offset cannot decide the verdict.
 */
const CLOCK_TIME = /\d{1,2}:\d{2}/;

const SERIES = [
	// Noon UTC: the backdating sentinel, which is the case that is provably a fabricated time.
	{ capturedAt: '2026-05-01T12:00:00.000Z', totalCents: 150_000 },
	// A real moment, from the "save a balance now" path. Rendered the same way, deliberately.
	{ capturedAt: '2026-06-15T09:37:12.000Z', totalCents: 175_000 }
];

describe('NetWorthChart.svelte — the accessible table announces a day, not a time (#204)', () => {
	it('renders no clock time anywhere in the screen-reader table', async () => {
		render(NetWorthChart, { series: SERIES });

		const table = page.getByRole('table').element();
		expect(table.textContent ?? '').not.toMatch(CLOCK_TIME);
	});

	it('the control: the table still names both days, so the assertion above is not vacuous', async () => {
		// Without this, deleting the table entirely would pass the test above. The absence
		// assertion needs an absolute figure beside it.
		render(NetWorthChart, { series: SERIES });

		const rows = page.getByRole('row').elements();
		expect(rows.length).toBe(2);
	});

	it('renders no clock time in the point aria-label either, which is the same string', async () => {
		render(NetWorthChart, { series: SERIES });

		const labels = page
			.getByRole('button')
			.elements()
			.map((element) => element.getAttribute('aria-label') ?? '');
		expect(labels.length).toBe(2);
		expect(labels.join(' | ')).not.toMatch(CLOCK_TIME);
	});
});
