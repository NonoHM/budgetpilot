import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@sveltejs/kit';
// Message FUNCTIONS, never retyped copy — the neighbouring specs state the rule: a spec that
// copies the sentence goes on passing while the catalogue says something else.
import * as m from '$lib/paraglide/messages';
import { splitSaveFailureMessage } from './split-save-failure';

/**
 * The classification the split editor's 1i banner is driven by.
 *
 * ABSOLUTE assertions, not a comparison between two branches: a spec that only checked "redirect
 * and error produce different sentences" would pass with both of them empty. Each case names the
 * message it must produce, and the two silent cases name the reason they are silent.
 */
describe('splitSaveFailureMessage', () => {
	it('names the session as the cause for a redirect, because that is the only redirect this action can produce', () => {
		const result: ActionResult = { type: 'redirect', status: 303, location: '/login?redirectTo=x' };
		expect(splitSaveFailureMessage(result)).toBe(m.splits_error_session_expired());
	});

	it('promises the parts are kept BEFORE it says what happened, on both failure sentences', () => {
		// The order is the requirement, not the wording: 1i asks that the sentence « promises what
		// matters first, that nothing is lost ». Asserted on the shared opening rather than on a
		// substring anywhere in the text, so a rewrite that moves the promise to the end goes red.
		const promise = m.splits_error_generic();
		expect(m.splits_error_session_expired().startsWith(promise)).toBe(true);
		expect(m.splits_error_unreachable().startsWith(promise)).toBe(true);
	});

	it('names the transport for an error, which is what a dropped connection deserialises to', () => {
		const result: ActionResult = { type: 'error', error: new Error('failed to fetch') };
		expect(splitSaveFailureMessage(result)).toBe(m.splits_error_unreachable());
	});

	it('is silent for a success, which is the write itself', () => {
		const result: ActionResult = { type: 'success', status: 200, data: { splitsSaved: true } };
		expect(splitSaveFailureMessage(result)).toBeNull();
	});

	it('is silent for a failure, which the server has already explained through splitsError', () => {
		// The exact shape `?/saveSplits` returns from `fail(400, …)`. Silence here is what leaves
		// `form.splitsError` as the single sentence, rather than two competing for the one banner.
		const result: ActionResult = {
			type: 'failure',
			status: 400,
			data: { splitsError: m.splits_error_sum() }
		};
		expect(splitSaveFailureMessage(result)).toBeNull();
	});
});
