import * as m from '$lib/paraglide/messages';
import type { ProposalSource } from '$lib/domain/historySuggestion';

/**
 * Where a proposed category comes from, as the member reads it beside the proposal (1.4 plan,
 * section 3b rule 5). Never a score (#407). One definition for the list, the mobile card and the
 * proposal card.
 */
export function proposalSource(proposal: { source: ProposalSource }): string {
	switch (proposal.source) {
		case 'rule':
			return m.transactions_proposal_from_rule();
		case 'history':
			return m.transactions_proposal_from_history();
		case 'similar':
			return m.transactions_proposal_from_similar();
	}
}
