import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TransactionProposalCard from './TransactionProposalCard.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * #1014: a proposal says where it comes from (1.4 plan, section 3b rule 5), and the accept posts
 * the proposal it showed, which is what lets the server tell an accepted proposal from the
 * member's own pick and refuse one on a row filed since. Each variant is rendered, because the
 * desktop panel and the mobile/focus card are two separate blocks of markup.
 */

function props(suggestion: { category: string; nature: null; source: 'rule' | 'history' } | null) {
	return {
		transactionId: 'tx-1',
		suggestion,
		categoryOptions: ['Courses', 'Loisirs'],
		natureOptions: [],
		getCategoryColor: () => 'bg-zinc-400',
		formatNatureLabel: (n: string | null) => n ?? '',
		onAccepted: () => {},
		onIgnore: () => {},
		onCreateRule: () => {}
	};
}

const posted = (container: HTMLElement) =>
	(container.querySelector('input[name="proposed"]') as HTMLInputElement | null)?.value;

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
});
