import { log } from '$lib/server/logging';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import { logUserPseudonym } from './pseudonym.ts';
import type {
	AuthzReference,
	TargetedAdminAction,
	UntargetedAdminAction,
	UserFields
} from './events.ts';

export type {
	AdminAction,
	AuthzReference,
	TargetedAdminAction,
	UntargetedAdminAction
} from './events.ts';

/**
 * The authorization events (L4a, part of #250), and the only code that builds them
 * (`authzConstructor.spec.ts`). A caller hands over the raw user id and never a pseudonym: the keyed
 * hash is taken here, as in `authn.ts`, so no route can log a raw id under a pseudonym's name.
 *
 * WHO CARRIES WHAT. The account by its pseudonym, never the client or its subnet (R1 on #841: those
 * belong to authentication), and never the reference itself: only its closed kind. The event types
 * in `events.ts` refuse a client field, by literal or by spread.
 *
 * WHEN. `logReferenceRefused` where a userId-scoped lookup of a client reference found nothing AND
 * the answer is the one a missing row gets: the log mirrors the answer, so a foreign row, a missing
 * row and a malformed id answered like a missing one write the same line, and an id refused with an
 * answer of its own writes nothing here. Never a second lookup without userId to tell them apart
 * (#830). `logRoleRefused` just before an admin-only refusal is thrown. `logAdminAction` after the
 * action's commit returns, success only.
 *
 * THE ANSWER DOES NOT MOVE. Each function is one or two HMACs and one synchronous write, and none
 * returns anything a caller could branch on.
 */

function user(userId: string): UserFields {
	return { [A.userPseudonym]: logUserPseudonym(userId) };
}

/** A client-supplied reference did not resolve under the caller's userId. */
export function logReferenceRefused(userId: string, reference: AuthzReference): void {
	log({
		event: E.authzFail,
		attributes: {
			...user(userId),
			[A.authzReason]: 'not_found_or_not_owned',
			[A.authzReference]: reference
		}
	});
}

/** A signed-in member reached something only an admin may. */
export function logRoleRefused(userId: string): void {
	log({ event: E.authzFail, attributes: { ...user(userId), [A.authzReason]: 'role_required' } });
}

/** An admin action committed. The target is required for the three targeted actions, forbidden otherwise. */
export function logAdminAction(
	adminId: string,
	...call: [action: TargetedAdminAction, targetUserId: string] | [action: UntargetedAdminAction]
): void {
	log({
		event: E.authzAdmin,
		attributes:
			call.length === 1
				? { ...user(adminId), [A.adminAction]: call[0] }
				: {
						...user(adminId),
						[A.adminAction]: call[0],
						[A.targetUserPseudonym]: logUserPseudonym(call[1])
					}
	});
}
