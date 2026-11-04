import * as m from '$lib/paraglide/messages';

/**
 * Where a proposed category comes from, as the member reads it beside the proposal (1.4 plan,
 * section 3b rule 5). Never a score (#407). One definition for the list, the mobile card and the
 * proposal card.
 */
export function proposalSource(proposal: { source: 'rule' | 'history' }): string {
	return proposal.source === 'history'
		? m.transactions_proposal_from_history()
		: m.transactions_proposal_from_rule();
}
