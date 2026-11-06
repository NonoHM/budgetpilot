import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import AmountSignStep from './AmountSignStep.svelte';

/** Distinct line boxes the text of `el` renders on, read from the layout rather than its height. */
function renderedLines(el: Element) {
	const range = document.createRange();
	range.selectNodeContents(el);
	return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

/**
 * #1306: the member decides the sign of exactly these figures, so « 9,3 » over « 0 » is a false
 * displayed amount. Separates « a short amount stays on one line beside a label that wraps » from
 * « the amount cell shrinks to one character and `break-all` cuts the number », measured on the
 * #1294 walk at 390 in French.
 */
describe('the sign step sample rows at 390', () => {
	it('keep every short amount on one line beside a long label', async () => {
		await page.viewport(390, 844);
		const label =
			'PRLV SEPA ECHEANCE PRET IMMOBILIER CREDIT MUTUEL DE BRETAGNE REFERENCE MANDAT ABCDEF';
		const amounts = ['18,77', '61,00', '9,30'];
		render(AmountSignStep, {
			prompt: {
				fact: 'Aucun montant ne porte de signe.',
				rows: amounts.map((amount) => ({ label, date: '03/04/2026', amount })),
				outFirst: '-18,77',
				inFirst: '+18,77'
			},
			onChoose: () => {},
			onBack: () => {}
		});
		await expect.element(page.getByTestId('amount-sign-step')).toBeVisible();

		const cells = [
			...document.querySelectorAll('[data-testid="amount-sign-row"] > span:last-child')
		];
		expect(cells.map((cell) => cell.textContent)).toEqual(amounts);
		// The label must wrap, or the row never put the amount under pressure.
		expect(renderedLines(cells[0].previousElementSibling!)).toBeGreaterThan(1);
		expect(cells.map(renderedLines)).toEqual([1, 1, 1]);
	});
});
