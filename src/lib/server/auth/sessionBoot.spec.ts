import { beforeEach, describe, expect, it, vi } from 'vitest';

const applySessionSettings = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/auth', () => ({ applySessionSettings }));

const logged = vi.hoisted(() => [] as { event: string; attributes: Record<string, unknown> }[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: { event: string; attributes: Record<string, unknown> }) => {
		logged.push(event);
	}
}));

const { applySessionSettingsAtStart } = await import('./sessionBoot');

/**
 * #1087: the startup step says how many stored sessions it shortened. Literal names, so a rename in
 * names.ts reddens this rather than following along.
 */
describe('applySessionSettingsAtStart (#1087)', () => {
	beforeEach(() => {
		logged.length = 0;
	});

	// The count the step returned vs. a line without it, or no line.
	it('logs the number of sessions it shortened', async () => {
		applySessionSettings.mockResolvedValueOnce(3);
		await applySessionSettingsAtStart();
		expect(logged).toEqual([
			{
				event: 'budgetpilot.session.settings_applied',
				attributes: { 'budgetpilot.session.shortened': 3 }
			}
		]);
	});

	// 0 is written too: a missing line then means the step did not complete, never « nothing to do ».
	it('logs 0 when no session needed shortening', async () => {
		applySessionSettings.mockResolvedValueOnce(0);
		await applySessionSettingsAtStart();
		expect(logged.map((line) => line.attributes['budgetpilot.session.shortened'])).toEqual([0]);
	});
});
