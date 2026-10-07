import { applySessionSettings } from '$lib/server/auth';

/**
 * The startup step of #221: brings every live session within `BP_SESSION_IDLE_TIMEOUT_HOURS` and
 * `SESSION_TTL_DAYS` as they are now, so lowering either takes effect at once. A module of its own,
 * like the other startup passes, so `hooks.server.init.spec.ts` can replace it.
 *
 * A failure throws and stops the start, as the other passes do: a lowered setting left unapplied
 * would keep sessions working past it, which is the one outcome this step exists to prevent.
 */
export async function applySessionSettingsAtStart(): Promise<void> {
	await applySessionSettings(new Date());
}
