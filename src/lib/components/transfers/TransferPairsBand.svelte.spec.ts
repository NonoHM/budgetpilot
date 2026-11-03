import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import TransferPairsBand from './TransferPairsBand.svelte';
import * as m from '$lib/paraglide/messages';
import { formatCents } from '$lib/domain/budget';

// #1189. Synthetic accounts and amounts; the band only draws what the server proposed.
const PAIR = {
	outId: 'out-1',
	inId: 'in-1',
	fromAccount: 'Compte courant',
	toAccount: 'Livret A',
	outDate: '2026-03-10',
	inDate: '2026-03-12',
	amountCents: 50000
};
const SECOND = { ...PAIR, outId: 'out-2', inId: 'in-2', toAccount: 'PEL', amountCents: 15000 };
const iso = (value: string) => value;

describe('TransferPairsBand.svelte', () => {
	it('renders nothing when the server proposed no pair, even with ambiguous legs', async () => {
		await render(TransferPairsBand, {
			pairs: [],
			ambiguousCount: 3,
			formatAmount: formatCents,
			formatDate: iso
		});
		await expect.element(page.getByTestId('transfer-pairs-band')).not.toBeInTheDocument();
	});

	it('names each pair by its route and amount, and posts both ids for it', async () => {
		const { container } = await render(TransferPairsBand, {
			pairs: [PAIR],
			ambiguousCount: 0,
			formatAmount: formatCents,
			formatDate: iso
		});
		const link = page.getByRole('button', {
			name: m.transfer_pairs_link_aria({
				amount: formatCents(50000),
				from: 'Compte courant',
				to: 'Livret A'
			})
		});
		await expect.element(link).toBeVisible();
		await expect
			.element(page.getByRole('heading', { level: 2 }))
			.toHaveTextContent(m.transfer_pairs_title_one());
		const form = container.querySelector('form[action="?/linkTransferPair"]')!;
		const posted = Object.fromEntries(new FormData(form as HTMLFormElement));
		expect(posted).toEqual({ outId: 'out-1', inId: 'in-1' });
	});

	it('offers « Link all » only when there is more than one pair', async () => {
		const { rerender } = await render(TransferPairsBand, {
			pairs: [PAIR],
			ambiguousCount: 0,
			formatAmount: formatCents,
			formatDate: iso
		});
		// The label a one-pair band WOULD carry, so the absence is checked on the right name.
		const one = page.getByRole('button', { name: m.transfer_pairs_link_all({ count: 1 }) });
		await expect.element(one).not.toBeInTheDocument();
		await rerender({ pairs: [PAIR, SECOND] });
		await expect
			.element(page.getByRole('button', { name: m.transfer_pairs_link_all({ count: 2 }) }))
			.toBeVisible();
	});

	// Passes 1189-code-1A N19, 1B N16: the count is TRANSACTIONS (legs), under a title counting
	// transfers, so the sentence names its own unit. Compared as the whole sentence, in French
	// because the component suite pins that locale (vitest.client.setup.ts).
	it('says how many transactions were left out, naming the unit', async () => {
		await render(TransferPairsBand, {
			pairs: [PAIR],
			ambiguousCount: 3,
			formatAmount: formatCents,
			formatDate: iso
		});
		await expect
			.element(page.getByText(m.transfer_pairs_ambiguous_many({ count: 3 })))
			.toHaveTextContent(
				'3 autres transactions ne sont pas proposées, faute de correspondance certaine.'
			);
	});

	it('shows one date when both legs share it, and both otherwise', async () => {
		const { rerender } = await render(TransferPairsBand, {
			pairs: [PAIR],
			ambiguousCount: 0,
			formatAmount: formatCents,
			formatDate: iso
		});
		await expect.element(page.getByText('2026-03-10 – 2026-03-12')).toBeVisible();
		await rerender({ pairs: [{ ...PAIR, inDate: PAIR.outDate }] });
		await expect.element(page.getByText('2026-03-10', { exact: true })).toBeVisible();
	});

	// Passes 1189-code-1A N21, 1B N17: the window is symmetric, so money can arrive dated first.
	it('reads the range from the earlier date to the later one, whichever leg is first', async () => {
		await render(TransferPairsBand, {
			pairs: [{ ...PAIR, outDate: '2026-01-05', inDate: '2026-01-03' }],
			ambiguousCount: 0,
			formatAmount: formatCents,
			formatDate: iso
		});
		await expect.element(page.getByText('2026-01-03 – 2026-01-05')).toBeVisible();
	});
});
