import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { formatCents } from '$lib/domain/budget';
import type { CategoryAllocation } from '$lib/domain/allocation';
import { buildCashFlowSankey } from '$lib/domain/cashFlowSankey';
import CashFlowSankey from './CashFlowSankey.svelte';

// #190. Tests run in `fr` (vitest.client.setup.ts pins the cookie).
function row(category: string, amountCents: number): CategoryAllocation {
	return {
		transactionId: `${category}-${amountCents}`,
		date: '2026-06-10',
		category,
		amountCents,
		nature: amountCents > 0 ? 'income' : 'spending',
		kind: amountCents > 0 ? 'income' : 'expense',
		transferPaired: false
	};
}

const surplus = buildCashFlowSankey([
	row('Salaire', 250_000),
	row('Loyer', -90_000),
	row('Courses', -45_000),
	row('Transport', -12_000),
	row('Loisirs', -8_000),
	row('Santé', -4_000),
	row('Cadeaux', -2_000)
]);
const collapse = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe('CashFlowSankey', () => {
	// Separates « the diagram where its labels fit, the list alone where they do not » (ruled in #1193).
	it('draws the diagram at 1280: one income node, five out, the left-over and the total', async () => {
		await page.viewport(1280, 800);
		render(CashFlowSankey, { flow: surplus });
		// Node rectangles only: the two label clip paths hold a rectangle each.
		await expect
			.poll(() => document.querySelectorAll('svg rect:not(clipPath rect)').length)
			.toBe(8);
	});

	// Contradiction pass, 2026-11-27: a long name beside a large amount ran past the drawing's edge,
	// and the clip cut the amount's last digit. Separates « the amount is whole and inside » from
	// « a figure can lose a character ».
	it('keeps a large amount whole and inside the drawing beside a long category name', async () => {
		await page.viewport(1280, 800);
		render(CashFlowSankey, {
			flow: buildCashFlowSankey([
				row('Salaire', 2_000_000),
				row('Abonnements et logiciels de bureau', -1_234_567)
			])
		});
		await expect.poll(() => document.querySelectorAll('svg text').length).toBeGreaterThan(0);
		const svg = document.querySelector('svg')!;
		const amount = [...svg.querySelectorAll('text')].find(
			(text) => text.textContent?.trim() === formatCents(1_234_567)
		);
		expect(amount, 'the amount is drawn whole').toBeDefined();
		// getBBox ignores clipping, so the clip is asserted absent separately.
		expect(amount!.getAttribute('clip-path')).toBeNull();
		const box = amount!.getBBox();
		expect(box.x + box.width).toBeLessThanOrEqual(svg.viewBox.baseVal.width);
	});

	// Separates « a spending category wears the page's colour » from every node in the neutral grey
	// (the page once passed no map, and every node rendered grey with all tests green).
	it('colours a spending node, its ribbon and its list dot from the page map', async () => {
		await page.viewport(1280, 800);
		render(CashFlowSankey, { flow: surplus, colors: { Loyer: '#6366f1' } });
		await expect.poll(() => document.querySelectorAll('svg rect[fill="#6366f1"]').length).toBe(1);
		expect(document.querySelectorAll('svg path[fill="#6366f1"]')).toHaveLength(1);
		expect(document.querySelectorAll('[data-cash-flow="out"] .bg-\\[\\#6366f1\\]')).toHaveLength(1);
	});

	it('shows only the list at 390', async () => {
		await page.viewport(390, 844);
		render(CashFlowSankey, { flow: surplus });
		await expect.element(page.getByRole('heading', { name: 'Sorties' })).toBeInTheDocument();
		expect(document.querySelectorAll('svg')).toHaveLength(0);
	});

	it('lists what went out, the smallest folded into « 2 autres catégories » with their names, and what is left', async () => {
		render(CashFlowSankey, { flow: surplus });
		await expect.element(page.getByRole('heading', { name: 'Sorties' })).toBeInTheDocument();
		const out = [...document.querySelectorAll('[data-cash-flow="out"] li')].map((item) =>
			collapse(item.textContent)
		);
		expect(out).toEqual([
			collapse(`Loyer ${formatCents(90_000)}`),
			collapse(`Courses ${formatCents(45_000)}`),
			collapse(`Transport ${formatCents(12_000)}`),
			collapse(`Loisirs ${formatCents(8_000)}`),
			collapse(`2 autres catégories Santé, Cadeaux ${formatCents(6_000)}`)
		]);
		expect(collapse(document.querySelector('[data-cash-flow="balance"]')?.textContent)).toBe(
			collapse(`Reste ${formatCents(89_000)}`)
		);
	});

	it('names the gap when spending went beyond income', async () => {
		render(CashFlowSankey, {
			flow: buildCashFlowSankey([row('Salaire', 100_000), row('Loyer', -130_000)])
		});
		await expect.element(page.getByRole('heading', { name: 'Entrées' })).toBeInTheDocument();
		expect(collapse(document.querySelector('[data-cash-flow="balance"]')?.textContent)).toBe(
			collapse(`Dépensé au-delà des revenus ${formatCents(30_000)}`)
		);
	});

	it('says so when nothing came in or went out', async () => {
		render(CashFlowSankey, { flow: buildCashFlowSankey([]) });
		await expect
			.element(page.getByText('Aucune entrée ni sortie sur cette période.'))
			.toBeInTheDocument();
		expect(document.querySelectorAll('[data-cash-flow]')).toHaveLength(0);
	});
});
