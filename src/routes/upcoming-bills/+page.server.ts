import { requireUser } from '$lib/server/auth';
import { parseMonth } from '$lib/server/budget/dashboard';
import { loadUpcomingBillsMonth } from '$lib/server/upcoming-bills/service';
import type { PageServerLoad } from './$types';

/**
 * Read-only month view. The row actions (mark paid, ignore, restore, stop detecting) land in a
 * later task and will be `export const actions` here — nothing on this page mutates today.
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
