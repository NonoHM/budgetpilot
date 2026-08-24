import { json } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import {
	AccountWriteError,
	MAX_ACCOUNT_NAME_LENGTH,
	createStatementAccount,
	type AccountCreateRefusal,
	type AccountWriteRefusal
} from '$lib/server/accounts/service';
import { findDiscriminantColumn } from '$lib/server/import/discriminant';
import {
	IMPORT_FILE_MAX_BYTES,
	isSupportedImportFile,
	readImportFile
} from '$lib/server/import/file';
import type { RequestHandler } from './$types';

/**
 * « Créer et sélectionner », the one write the create sheet performs.
 *
 * ## Why an endpoint rather than a form action
 *
 * Not a preference. `/import/columns/+page.server.ts` exports a `default` action, and SvelteKit
 * refuses a route that carries both a default and a named action, so there is no second action to
 * add on the screen the sheet belongs to. Posting to another route's action would put account
 * creation behind a page that does not exist yet (Task 9's), which is drafting rather than
 * building.
 *
 * It costs nothing here that a form action would have given: the designation flow is already
 * JavaScript-only by construction, because the FILE lives in memory and a full-page POST would lose
 * it. That is the same reason the import itself is posted with `fetch` and
 * `x-sveltekit-action` rather than by submitting the form.
 *
 * ## The file is re-posted, and that is what makes the fragment trustworthy
 *
 * `Account.discriminant` is the value rank 1 later treats as CERTAIN: it is what lets the
 * application say « this statement belongs to that account » without asking. A fragment read out of
 * the REQUEST would be a claim, and rank 1 would be certain about a claim. So the server re-reads
 * the bytes and runs its own `findDiscriminantColumn` over them, which is the doctrine
 * `/import/columns` states for every value it accepts: the client's indices are the only input that
 * survives, and everything else is recomputed.
 *
 * The file is OPTIONAL rather than required. Without it the account is created with no fragment,
 * which is exactly the account a file carrying no identifier column would have produced. Nothing is
 * gained by omitting it: a null is not shared, so the « two accounts may not hold one fragment »
 * invariant is untouched, and the create stays reusable by a caller that has no file at all.
 *
 * ## The closed allow list is the two lines that read the body
 *
 * `name` and `csvFile`. Nothing else is read, so `source`, `discriminant`, `netWorthAccountId`,
 * `archivedAt` and `institution` cannot be set whatever the request carries. Validating positively
 * rather than stripping a deny list is the difference between a rule about this endpoint and a
 * claim about every field the schema will ever have.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals.user);

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		// `formData()` REJECTS on a body it cannot parse, and an unhandled rejection in an endpoint
		// is a 500 with a stack trace in the log. The refusal is generic on purpose: the caught value
		// is never rendered and never interpolated, so nothing internal can travel out through it.
		// ASVS 5.0 V16.5.1.
		return json({ error: m.import_account_create_error_generic() }, { status: 400 });
	}

	const posted = formData.get('name');
	const name = typeof posted === 'string' ? posted : '';
	const discriminant = await fragmentFromFile(formData.get('csvFile'));

	try {
		const account = await createStatementAccount({ userId: user.id, name, discriminant });
		return json({
			account: {
				id: account.id,
				name: account.name,
				discriminant: account.discriminant,
				// Zero by construction rather than by a second query. An account that has just been
				// created has no transactions, and reading the count back would let the option show a
				// figure whose only possible value is the one written here.
				transactionCount: 0
			}
		});
	} catch (caught) {
		if (caught instanceof AccountWriteError && isCreateRefusal(caught.reason)) {
			// `field: 'name'` because ALL FOUR refusals this can return are about the name and are
			// fixable by editing it. The client renders a fixable refusal under the input, with
			// `aria-invalid` and the focus back in the field; a failure the user cannot fix is a
			// banner. Saying which is the server's to say: it is the side that knows what refused.
			return json({ error: refusalSentence(caught.reason), field: 'name' }, { status: 400 });
		}
		throw caught;
	}
};

/**
 * The fragment THIS server read, or null.
 *
 * Every way of not knowing collapses to null rather than to a refusal: no file, a file whose
 * extension the import path does not accept, one too large to read, one that is empty, and one
 * whose identifier column varies per row (a multi-account export, which is evidence AGAINST a
 * single account and must not be turned into one). The user asked to create an account with a name,
 * and none of those is a reason to refuse them one.
 */
async function fragmentFromFile(posted: FormDataEntryValue | null): Promise<string | null> {
	if (!(posted instanceof File) || posted.size === 0) return null;
	if (!isSupportedImportFile(posted.name)) return null;
	if (posted.size > IMPORT_FILE_MAX_BYTES) return null;

	try {
		const read = await readImportFile(posted, { maxBytes: IMPORT_FILE_MAX_BYTES });
		const found = findDiscriminantColumn(read.rows);
		return found.kind === 'found' ? found.fragment : null;
	} catch {
		return null;
	}
}

/**
 * One sentence per refusal, and they are four different sentences on purpose.
 *
 * A name the user can fix and a failure they cannot must not read alike: the first asks them to
 * type something else, the second tells them what survived. 6g's own copy makes that split, and the
 * discriminant case is the plate's « phrase du nom pris adaptée » rather than a fifth idea.
 */
function refusalSentence(reason: AccountCreateRefusal): string {
	switch (reason) {
		case 'name-required':
			return m.import_account_create_error_name_required();
		case 'name-taken':
			return m.import_account_create_error_name_taken();
		case 'discriminant-taken':
			return m.import_account_create_error_fragment_taken();
		case 'name-too-long':
			return m.import_account_create_error_name_too_long({ max: MAX_ACCOUNT_NAME_LENGTH });
	}
}

/**
 * Whether this refusal is one CREATING an account can produce.
 *
 * `createStatementAccount` throws only these four today, so this narrowing is currently total and
 * the alternative branch unreachable. Written anyway, because the alternative to narrowing is a
 * catch-all sentence: the two refusals this endpoint cannot receive are about an account that does
 * not exist and a net worth account that does not, and rendering either as « ce nom est trop long »
 * would be a false statement about the user's own input. An unexpected reason falls through to the
 * generic 500 below instead, which says nothing rather than something wrong.
 */
function isCreateRefusal(reason: AccountWriteRefusal): reason is AccountCreateRefusal {
	return (
		reason === 'name-required' ||
		reason === 'name-too-long' ||
		reason === 'name-taken' ||
		reason === 'discriminant-taken'
	);
}
