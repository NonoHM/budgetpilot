import { beforeEach, describe, expect, it, vi } from 'vitest';

const backup = vi.hoisted(() => ({
	buildBackupExport: vi.fn()
}));

vi.mock('$lib/server/backup/export', () => backup);

const { GET } = await import('./+server');

describe('GET /settings/export', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuse l'accès sans utilisateur connecté", async () => {
		expect.assertions(2);

		await expect(GET({ locals: { user: null } } as never)).rejects.toBeTruthy();
		expect(backup.buildBackupExport).not.toHaveBeenCalled();
	});

	it("construit l'export du user connecté uniquement (pas de userId client)", async () => {
		expect.assertions(2);

		backup.buildBackupExport.mockResolvedValue({
			formatVersion: 1,
			exportedAt: '2026-07-01T00:00:00.000Z',
			userEmail: 'user-a@example.test',
			accounts: [],
			categories: [],
			importBatches: [],
			transactions: [],
			monthlyBudgets: [],
			categoryRules: [],
			categorizationRules: [],
			categoryNatureMappings: []
		});

		await GET({
			locals: { user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' } }
		} as never);

		expect(backup.buildBackupExport).toHaveBeenCalledWith('user-a');
		expect(backup.buildBackupExport).toHaveBeenCalledTimes(1);
	});

	it('retourne le JSON en pièce jointe téléchargeable', async () => {
		expect.assertions(4);

		const payload = {
			formatVersion: 1,
			exportedAt: '2026-07-01T00:00:00.000Z',
			userEmail: 'user-a@example.test',
			accounts: [],
			categories: [],
			importBatches: [],
			transactions: [],
			monthlyBudgets: [],
			categoryRules: [],
			categorizationRules: [],
			categoryNatureMappings: []
		};
		backup.buildBackupExport.mockResolvedValue(payload);

		const response = await GET({
			locals: { user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' } }
		} as never);

		expect(response.headers.get('Content-Type')).toBe('application/json');
		expect(response.headers.get('Content-Disposition')).toContain('attachment');
		expect(response.headers.get('Content-Disposition')).toContain('.json');
		expect(await response.json()).toEqual(payload);
	});
});
