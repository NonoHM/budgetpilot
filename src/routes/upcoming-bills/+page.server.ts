import { fail, isHttpError } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import type { StreamActionKind } from '$lib/domain/upcomingBills';
import { requireUser } from '$lib/server/auth';
import { parseMonth } from '$lib/server/budget/dashboard';
import {
	loadUpcomingBillsMonth,
	recordStreamAction,
	undoStreamAction
} from '$lib/server/upcoming-bills/service';
import type { Actions, PageServerLoad } from './$types';

/**
 * Read-only month view plus the four row mutations.
 *
 * The month goes through `parseMonth` rather than a local regex: it returns the current month for
 * an absent parameter and throws a 400 for a malformed one, which is what keeps `formatMonthLabel`
 * (a deliberate `RangeError` on a bad key) from turning a hand-edited URL into a 500 in the
 * component.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const month = parseMonth(url.searchParams.get('month'));

	// `user.id` comes from the session, never from the query string.
	return { bills: await loadUpcomingBillsMonth(user.id, month) };
};

/**
 * What a successful mutation hands back for the result banner. `month` is empty for the two kinds
 * whose copy does not name a period (`exclude`, `restore`); when it is set it is the `dueDate` the
 * service just validated, so the client can format it without re-testing the shape.
 */
interface BillActionResult {
	kind: StreamActionKind | 'restore';
	/** Feeds the banner's "Annuler"; null for `restore`, which has nothing left to undo. */
	actionId: string | null;
	month: string;
	/** The ANONYMIZED row label, echoed back from the form — never `actionPayload.label`. */
	label: string;
}

export const actions: Actions = {
	markPaid: async (event) => recordAction('paid', event),
	ignoreOccurrence: async (event) => recordAction('ignore', event),
	excludeStream: async (event) => recordAction('exclude', event),

	undoAction: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const actionId = getFormValue(formData, 'actionId');

		try {
			// Ownership lives in the service: it deletes by (id, userId) and 404s on a zero count, so a
			// forged id belonging to another account is indistinguishable from one that never existed.
			await undoStreamAction(user.id, actionId);
		} catch (caught) {
			return fail(getErrorStatus(caught), { billError: getErrorMessage(caught) });
		}

		const result: BillActionResult = { kind: 'restore', actionId: null, month: '', label: '' };
		return { billAction: result };
	}
};

type ActionEvent = Parameters<NonNullable<Actions['markPaid']>>[0];

async function recordAction(kind: StreamActionKind, { locals, request }: ActionEvent) {
	const user = requireUser(locals.user);
	const formData = await request.formData();

	// Parsed here rather than in the service because a hand-edited (or truncated) hidden field would
	// otherwise throw a SyntaxError out of `JSON.parse` and surface as a 500. The service still
	// re-checks the element type, the count, the length and — the part that matters — the ownership
	// of every id against `user.id`.
	const anchorTransactionIds = parseAnchorIds(getFormValue(formData, 'anchorTransactionIds'));
	if (!anchorTransactionIds) {
		return fail(400, { billError: m.upcoming_bills_error_invalid_stream() });
	}

	// An exclude targets the whole stream and the service refuses one carrying a due date, so the
	// field is simply absent from that form; '' becomes null here rather than reaching it as ''.
	const dueDate = getFormValue(formData, 'dueDate').trim();

	try {
		// Object literal on purpose: `normalizedLabel` is NOT part of `RecordStreamActionInput` — the
		// service derives it from the label it stores — and only a direct literal gets TypeScript's
		// excess-property check, which is what makes forwarding it a compile error rather than a
		// silently ignored field.
		const { actionId } = await recordStreamAction(user.id, {
			kind,
			direction: getFormValue(formData, 'direction'),
			label: getFormValue(formData, 'label'),
			dueDate: dueDate || null,
			anchorTransactionIds
		});

		const result: BillActionResult = {
			kind,
			actionId,
			// Reached only after `recordStreamAction` accepted it, so it is a real ISO date and its
			// first seven characters are a month key `formatMonthLabel` can take.
			month: dueDate ? dueDate.slice(0, 7) : '',
			label: getFormValue(formData, 'displayLabel')
		};
		return { billAction: result };
	} catch (caught) {
		return fail(getErrorStatus(caught), { billError: getErrorMessage(caught) });
	}
}

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value : '';
}

/** `null` for anything that is not a JSON array of strings — the caller turns that into a 400. */
function parseAnchorIds(raw: string): string[] | null {
	if (!raw.trim()) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed)) return null;
	if (!parsed.every((id) => typeof id === 'string')) return null;
	return parsed;
}

/**
 * Only an `error()` thrown by the service carries a message meant for a user; anything else (a
 * Prisma failure, say) is reported through a generic key rather than by echoing `caught.message`,
 * which can hold connection or query detail.
 */
function getErrorMessage(caught: unknown): string {
	return isHttpError(caught) ? caught.body.message : m.upcoming_bills_error_invalid_action();
}

function getErrorStatus(caught: unknown): number {
	return isHttpError(caught) ? caught.status : 400;
}
