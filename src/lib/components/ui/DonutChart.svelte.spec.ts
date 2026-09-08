import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import DonutChart from './DonutChart.svelte';
import { apportionPercentages } from '$lib/domain/apportion';
import type { DonutSegment } from './DonutChart.svelte';

/**
 * The legend's percentages, read off the rendered card rather than computed.
 *
 * Reading the DOM is the point: the defect is what a person sees, and every level below the
 * screen was already correct. `formatPercent` puts a narrow no-break space before the `%` in
 * `fr`, which is the locale the client project pins, so the digits are extracted rather than the
 * string compared.
 */
function legendPercents(container: HTMLElement): number[] {
	return [...container.querySelectorAll('ul li span:last-child')].map((el) =>
		Number((el.textContent ?? '').replace(/[^\d-]/g, ''))
	);
}

function segments(pcts: number[]): DonutSegment[] {
	return pcts.map((pct, i) => ({ label: `C${i}`, color: '#111111', pct }));
}

function renderDonut(pcts: number[]) {
	return render(DonutChart, {
		segments: segments(pcts),
		othersColor: '#d4d4d8',
		title: 'Sorties par catégorie',
		meta: '200,00 €',
		centerCaption: 'Total',
		centerValue: '200,00 €',
		emptyText: 'Rien'
	});
}

describe('DonutChart.svelte legend percentages', () => {
	/**
	 * Separates "the legend shows what the shared apportionment returns" from "the legend has its
	 * own arithmetic that happens to agree today".
	 *
	 * The expectation calls the production function rather than retyping its numbers, which is the
	 * only form that can catch a second implementation drifting from the first. It is the reason
	 * /reports can print these same five shares in three places without three chances to disagree:
	 * the page computes them once and the legend reaches the same answer by calling the same
	 * function, not by being kept in step.
	 */
	it('prints exactly what apportionPercentages returns for its own segments', async () => {
		expect.assertions(3);
		await page.viewport(1280, 900);

		for (const pcts of [
			[50.5, 49.5],
			[100 / 3, 100 / 3, 100 / 3],
			[42.4, 21.3, 8.3]
		]) {
			const { container } = renderDonut(pcts);
			expect(legendPercents(container)).toEqual(apportionPercentages(pcts));
		}
	});

	/**
	 * Separates "the printed shares add up to the whole they are shares of" from "each share was
	 * rounded on its own and the total is whatever that happens to give".
	 *
	 * The input is two expense categories at 101,00 and 99,00 euros of a 200,00 euro total, so the
	 * exact shares are 50.500 and 49.500 and they sum to exactly 100 before anything is rounded.
	 * Measured on 2026-09-08 against the shipped code: it prints 51 % and 50 %, which is 101. That
	 * measured figure is the acceptance criterion here, not merely that this test can go red.
	 */
	it('two shares of 50.5 and 49.5 print 51 and 49, not 51 and 50', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const { container } = renderDonut([50.5, 49.5]);

		expect(legendPercents(container)).toEqual([51, 49]);
		expect(legendPercents(container).reduce((a, b) => a + b, 0)).toBe(100);
	});

	/**
	 * Separates "the deficit is handed to the largest fractional part" from "every share is
	 * floored or rounded independently and the total falls short".
	 *
	 * Three exact thirds is the other direction of the same defect: the shipped code prints
	 * 33 % three times, which is 99. Largest remainder gives the single leftover point to the
	 * first of the three tied fractions, so one row reads 34.
	 */
	it('three exact thirds print 34, 33 and 33, not 33 three times', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const third = 100 / 3;
		const { container } = renderDonut([third, third, third]);

		expect(legendPercents(container)).toEqual([34, 33, 33]);
		expect(legendPercents(container).reduce((a, b) => a + b, 0)).toBe(100);
	});

	/**
	 * Separates "the two points of deficit go to the two largest fractional parts" from "they are
	 * distributed by rounding each share on its own".
	 *
	 * 16.667 + 16.667 + 66.666 sums to exactly 100. The shipped code prints 17 + 17 + 67, which is
	 * 101, measured 2026-09-08. Largest remainder floors to 16 + 16 + 66 = 98 and gives its two
	 * spare points to the two .667 fractions, so the large slice reads 66 rather than 67. That the
	 * biggest slice is the one that moves is the whole reason the shortcut of forcing the last
	 * category to "100 minus the rest" is refused: it would put all the error on one slice by
	 * construction rather than on the slice with the smallest claim to it.
	 */
	it('16.667, 16.667 and 66.666 print 17, 17 and 66, not 17, 17 and 67', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const { container } = renderDonut([16.667, 16.667, 66.666]);

		expect(legendPercents(container)).toEqual([17, 17, 66]);
		expect(legendPercents(container).reduce((a, b) => a + b, 0)).toBe(100);
	});

	/**
	 * Separates "the labelled rows are apportioned within the whole ring" from "the labelled rows
	 * are inflated to 100 because they are the rows that have labels".
	 *
	 * This is the design we are NOT taking, asserted rather than described. On /reports the legend
	 * shows the top five categories and the ring draws everything else as one unlabelled arc, so
	 * the labelled rows are a subset and must keep summing to their own share of the whole. Running
	 * largest remainder over the displayed subset alone would print 50, 33 and 17 here and claim
	 * the reader's five categories are all of their spending.
	 *
	 * It passes on the shipped code too, which is exactly why it is written down: it is the
	 * regression this change could introduce and nothing else in the suite would catch it.
	 */
	it('a labelled subset beside a remainder arc is not inflated to 100', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const { container } = renderDonut([30, 20, 10]);

		expect(legendPercents(container)).toEqual([30, 20, 10]);
		expect(legendPercents(container).reduce((a, b) => a + b, 0)).toBe(60);
	});
});
