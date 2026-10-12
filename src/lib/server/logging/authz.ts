// L4a seam: bodies are empty until the implementation; the red tests import these names.

/**
 * The authorization events (L4a, part of #250), and the only code that builds them. Contract:
 * `docs/superpowers/2026-10-12-L4a-contract.md` (gitignored notes).
 */

/** The closed kind of a client-supplied reference that failed its userId-scoped lookup. */
export type AuthzReference =
	| 'transaction'
	| 'split_category'
	| 'rule'
	| 'category'
	| 'tag'
	| 'session'
	| 'column_mapping'
	| 'import_batch'
	| 'account'
	| 'net_worth_account'
	| 'budget'
	| 'savings_goal'
	| 'bill_action'
	| 'bank_connection'
	| 'bank_authorization'
	| 'remembered_account'
	| 'nature_mapping';

/** The admin actions that name an account as their target. */
export type TargetedAdminAction = 'delete_user' | 'reset_password' | 'create_account';
/** The admin actions that name no account. */
export type UntargetedAdminAction = 'create_invitation' | 'revoke_invitation';
export type AdminAction = TargetedAdminAction | UntargetedAdminAction;

/** A client-supplied reference did not resolve under the caller's userId. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function logReferenceRefused(userId: string, reference: AuthzReference): void {}

/** A signed-in member reached something only an admin may. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function logRoleRefused(userId: string): void {}

/** An admin action committed. The target is required for the three targeted actions, forbidden otherwise. */
export function logAdminAction(
	adminId: string,
	action: TargetedAdminAction,
	targetUserId: string
): void;
export function logAdminAction(adminId: string, action: UntargetedAdminAction): void;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function logAdminAction(adminId: string, action: AdminAction, targetUserId?: string): void {}
