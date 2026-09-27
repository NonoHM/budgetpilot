import { resolve } from '$app/paths';
import * as m from '$lib/paraglide/messages';
import type { AccountPickerOption } from '$lib/components/import/AccountPicker.svelte';

/** What the create sheet's host needs back: the option to add, or a sentence and where it goes. */
export type AccountCreationAnswer =
	{ ok: true; account: AccountPickerOption } | { ok: false; error: string; field?: string | null };

/**
 * « Créer et sélectionner », posted to the endpoint that owns the write. ONE definition for the two
 * hosts of the create sheet: the designation screen (`/import/columns`) and, since #741, the
 * currency refusal on `/import`.
 *
 * The FILE goes with it, and that is the point rather than an accident of what is in hand: the
 * fragment stored on the new account is what rank 1 will later treat as certain, so it has to be
 * read from the bytes by the server rather than claimed by the page.
 *
 * `currency` only from `/import`'s currency refusal, which asks for an account in the currency the
 * file declared. Absent, the endpoint creates the account in the application default, as it always
 * has for the designation screen. Present, the endpoint resolves it against its closed allow list.
 *
 * Resolves rather than throws, in both directions. The screen owns 6g's three states and needs an
 * ANSWER to move between them; an exception would leave it in flight for ever. The two cases with
 * no server answer at all are the ones that used to be silent everywhere in this flow: the fetch
 * rejecting, and a body that is not the JSON this endpoint returns (a crash outside it, or the
 * login page served after a session expired, which `fetch` follows on its own).
 *
 * ASVS 5.0 V16.5.1: the caught value is never rendered and never interpolated, so nothing
 * internal can reach the screen through this path.
 */
export async function requestAccountCreation(input: {
	name: string;
	file: File;
	currency?: string;
}): Promise<AccountCreationAnswer> {
	const body = new FormData();
	body.set('name', input.name);
	body.set('csvFile', input.file);
	if (input.currency !== undefined) body.set('currency', input.currency);
	try {
		const response = await fetch(resolve('/import/accounts'), { method: 'POST', body });
		const payload = (await response.json()) as {
			account?: AccountPickerOption;
			error?: string;
			field?: string | null;
		};
		if (response.ok && payload.account) return { ok: true, account: payload.account };
		return {
			ok: false,
			error: payload.error ?? m.import_account_create_error_generic(),
			field: payload.field ?? null
		};
	} catch {
		// No `field`: a fetch that never returned is not a refusal about the name, and putting it
		// under the input would tell the user to edit their way out of a network failure.
		return { ok: false, error: m.import_account_create_error_generic() };
	}
}
