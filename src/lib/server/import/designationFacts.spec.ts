import { describe, expect, it } from 'vitest';
import { EMPTY_ASSIGNMENT } from '$lib/domain/columnDesignation';
import { designationFactsAsDetected, withoutDesignations } from './designationFacts';
import { parseRows } from './utils/csv';

/**
 * An offer produced by a REMEMBERED mapping must not seed detection's columns over it (#352): one
 * press would save them under the same fingerprint. Separates « designations withdrawn, candidates
 * kept » from leaving the detected answer's designations in place. Only the detected answer: under
 * « données » `columnProposals` designates nothing, so there is nothing there to withdraw.
 */
describe('withoutDesignations', () => {
	const facts = designationFactsAsDetected(
		parseRows('Date;Détail;Montant\n24/02/2026;CARREFOUR;-24,90')
	);

	it('starts from a fixture where detection designates, or the withdrawal is unobservable', () => {
		expect.assertions(1);
		expect(facts.proposals?.designated).toEqual({ ...EMPTY_ASSIGNMENT, date: 0, amount: 2 });
	});

	it('withdraws the designations under the detected answer and keeps the candidates', () => {
		expect.assertions(1);
		expect(withoutDesignations(facts).proposals).toEqual({
			designated: EMPTY_ASSIGNMENT,
			candidates: facts.proposals?.candidates
		});
	});
});
