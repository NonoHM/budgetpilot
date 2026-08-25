import { describe, expect, it } from 'vitest';
import { BANK_LIST_FALLBACK_CODE } from '$lib/domain/failureCodes';
import { failureCode } from '$lib/server/errors';
import { EnableBankingApiError } from './enablebanking/http';
import { getEnableBankingCredentials } from './enablebanking/jwt';
import { recogniseBankListFailure } from './failures';

/**
 * WHY the connect form has no bank list (#524), not merely that it has none.
 *
 * `banks === null` had nine producers and one sentence, « La liste des banques est indisponible pour
 * le moment. Réessayez plus tard. » The Enable Banking private key was the case that made it worth
 * fixing: a missing key file is not a bank-list problem, is not temporary, and the screen said it
 * was both.
 *
 * `docs/bank-sync.md` had already written down that the sentence was false, in the same paragraph
 * that quoted it: "no amount of retrying changes anything, because the condition is on the
 * provider's side and is waiting for you". The documentation described the defect and nothing could
 * act on the description, which is what a code turns into a behaviour.
 */
describe('recogniseBankListFailure', () => {
	it('recognises a real configuration throw, not a hand-built one: both keys set at once', () => {
		expect.assertions(2);

		// Driven through the PRODUCTION reader rather than by constructing the error here. Constructing
		// it would assert that the recogniser reads a class this test just instantiated, which stays
		// green if `getEnableBankingCredentials` is later changed to throw a plain Error, and that
		// change is exactly what would put the operator back in front of the wrong sentence.
		let caught: unknown = null;
		try {
			getEnableBankingCredentials({
				ENABLE_BANKING_APP_ID: 'app-id',
				ENABLE_BANKING_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
				ENABLE_BANKING_PRIVATE_KEY_PATH: '/keys/eb.pem'
			});
		} catch (error) {
			caught = error;
		}

		// Separates "the reader refused" from "the reader returned null", which are different states:
		// null means unconfigured and reaches the screen through a different branch.
		expect(caught).not.toBeNull();
		expect(recogniseBankListFailure(caught)).toBe('not_configured');
	});

	it('recognises a real configuration throw: a key path naming no readable file', () => {
		expect.assertions(2);

		let caught: unknown = null;
		try {
			getEnableBankingCredentials({
				ENABLE_BANKING_APP_ID: 'app-id',
				ENABLE_BANKING_PRIVATE_KEY_PATH: 'no/such/key/anywhere-in-this-tree.pem'
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).not.toBeNull();
		// The instance #524 was reported for. It is an operator fault and cannot clear on its own,
		// which is the whole distinction from `unreachable`.
		expect(recogniseBankListFailure(caught)).toBe('not_configured');
	});

	it('separates a provider refusal from a configuration fault: provider_error', () => {
		expect.assertions(1);

		// The state docs/bank-sync.md documents: the application is not yet activated in the provider's
		// Control Panel, so the provider answers and refuses. Nothing local is wrong.
		expect(
			recogniseBankListFailure(
				new EnableBankingApiError(403, 'APPLICATION_NOT_ACTIVE', 'Enable Banking API error')
			)
		).toBe('provider_error');
	});

	it('recognises NOTHING it was not taught, so an unknown error cannot borrow another code', () => {
		expect.assertions(3);

		// The property that keeps the fallback honest. A recogniser that guessed would hand the screen
		// a confident wrong sentence, which is strictly worse than the generic one it replaces: the
		// generic sentence is vague, and a wrong specific sentence sends an operator to fix the wrong
		// thing. Returning null here is what routes these to `unreachable`.
		expect(recogniseBankListFailure(new Error('ECONNREFUSED'))).toBeNull();
		expect(recogniseBankListFailure(new TypeError('fetch failed'))).toBeNull();
		expect(recogniseBankListFailure('not an error at all')).toBeNull();
	});

	it('falls back to unreachable through failureCode, which is the code the route actually stores', () => {
		expect.assertions(2);

		// The route never calls the recogniser bare, so this is the composition the screen depends on.
		// Asserting the recogniser alone would leave the wiring untested, and the wiring is where a
		// null would otherwise reach the interface as an absent code.
		expect(
			failureCode(new Error('ECONNREFUSED'), recogniseBankListFailure, BANK_LIST_FALLBACK_CODE)
		).toBe('unreachable');
		expect(
			failureCode(
				new EnableBankingApiError(500, null, 'boom'),
				recogniseBankListFailure,
				BANK_LIST_FALLBACK_CODE
			)
		).toBe('provider_error');
	});
});
