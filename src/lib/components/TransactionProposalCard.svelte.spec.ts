import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import TransactionProposalCard from './TransactionProposalCard.svelte';
import * as m from '$lib/paraglide/messages';
import type { SeenRow } from '$lib/domain/seenRow';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';

/**
 * #1014: a proposal says where it comes from (1.4 plan, section 3b rule 5), and the accept posts
 * the proposal it showed, which is what lets the server tell an accepted proposal from the
 * member's own pick and refuse one on a row filed since. Each variant is rendered, because the
 * desktop panel and the mobile/focus card are two separate blocks of markup.
 */

function props(
	suggestion: { category: string; nature: null; source: 'rule' | 'history' } | null,
	seen: SeenRow = { category: null, nature: null }
) {
	return {
		transactionId: 'tx-1',
		suggestion,
		seen,
		categoryOptions: ['Courses', 'Loisirs'],
		natureOptions: [],
		getCategoryColor: () => 'bg-zinc-400',
		formatNatureLabel: (n: string | null) => n ?? '',
		onAccepted: () => {},
		onRefused: () => {},
		onIgnore: () => {},
		onCreateRule: () => {}
	};
}

const field = (container: HTMLElement, name: string) =>
	(container.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;
const posted = (container: HTMLElement) => field(container, 'proposed');

describe.each(['panel', 'compact'] as const)('the proposal card (%s)', (variant) => {
	it('says a history proposal comes from the member’s history, and posts it as proposed', async () => {
		const { container } = await render(TransactionProposalCard, {
			...props({ category: 'Courses', nature: null, source: 'history' }),
			variant
		});
		const label = [...container.querySelectorAll('p, span')].find(
			(el) => el.textContent?.trim() === m.transactions_proposal_from_history()
		);
		expect(label?.textContent?.trim()).toBe(m.transactions_proposal_from_history());
		expect(posted(container)).toBe('Courses');
	});

	it('says a rule proposal comes from a rule', async () => {
		const { container } = await render(TransactionProposalCard, {
			...props({ category: 'Courses', nature: null, source: 'rule' }),
			variant
		});
		expect(container.textContent).toContain(m.transactions_proposal_from_rule());
		expect(container.textContent).not.toContain(m.transactions_proposal_from_history());
	});

	it('names no source and posts no proposal when nothing was proposed', async () => {
		const { container } = await render(TransactionProposalCard, { ...props(null), variant });
		expect(container.textContent).not.toContain(m.transactions_proposal_from_rule());
		expect(container.textContent).not.toContain(m.transactions_proposal_from_history());
		expect(posted(container)).toBe('');
	});

	// #1233, point 1: with no proposal the card edits the row as it is. Separates a card seeded from
	// the row (the member's nature and pin survive an accept that only changes one of them) from a
	// card seeded from defaults (« Automatic » and the sentinel, which the accept then writes).
	it('starts on the row’s own nature and pin when nothing was proposed, and posts what it saw', async () => {
		const seen: SeenRow = { category: 'Loisirs', nature: 'spending' };
		const { container } = await render(TransactionProposalCard, { ...props(null, seen), variant });
		expect(field(container, 'nature')).toBe('spending');
		expect(field(container, 'category')).toBe('Loisirs');
		expect(field(container, 'seen')).toBe('{"category":"Loisirs","nature":"spending"}');
	});

	it('starts on the sentinel with « Automatic » on a row with no pin and no manual nature', async () => {
		const { container } = await render(TransactionProposalCard, { ...props(null), variant });
		expect(field(container, 'nature')).toBe('');
		expect(field(container, 'category')).toBe(UNCLASSIFIED_CATEGORY);
	});

	// Code pass 1A, F2: the panel's own nature editor saves, the page reloads, and the row's nature
	// moves under the card. Separates re-seeding each field on its own source from re-seeding both
	// on either, which threw away a category the member had picked but not yet accepted.
	it('keeps a picked category when only the row’s nature changed under the card', async () => {
		const screen = await render(TransactionProposalCard, { ...props(null), variant });
		await userEvent.click(page.getByRole('button', { name: m.common_combobox_open_list_aria() }));
		await userEvent.click(page.getByRole('option', { name: 'Loisirs' }));
		await expect.poll(() => field(screen.container, 'category')).toBe('Loisirs');
		await screen.rerender({ seen: { category: null, nature: 'spending' } });
		await expect.poll(() => field(screen.container, 'nature')).toBe('spending');
		expect(field(screen.container, 'category')).toBe('Loisirs');
	});

	// A proposal still decides both fields: the history proposal's empty nature lets the category's
	// mapping decide, which is what moves a row out of the nature pile.
	it('starts on the proposal, not the row, when one was proposed', async () => {
		const seen: SeenRow = { category: null, nature: 'uncategorized' };
		const { container } = await render(TransactionProposalCard, {
			...props({ category: 'Courses', nature: null, source: 'history' }, seen),
			variant
		});
		expect(field(container, 'nature')).toBe('');
		expect(field(container, 'category')).toBe('Courses');
		expect(field(container, 'seen')).toBe('{"category":null,"nature":"uncategorized"}');
	});
});
