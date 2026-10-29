import { beforeEach, describe, expect, it, vi } from 'vitest';

const backup = vi.hoisted(() => ({
	buildBackupExport: vi.fn()
}));

vi.mock('$lib/server/backup/export', () => backup);
// Every line the route writes, captured instead of printed (L4b-2 reads `sensitive_read`).
const logWriter = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: logWriter.log
}));
// The log pseudonyms import the limiter, which imports the database; nothing here queries it.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const { GET } = await import('./+server');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');

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

/**
 * L4b-2 (#250): a served backup writes `sensitive_read` with the bucket of the transactions it
 * carries. Wire names as literals, as in `logging/data.spec.ts`.
 */
describe('L4b-2: the backup export writes sensitive_read', () => {
	it('one line with the bucket of the transactions in the file', async () => {
		vi.clearAllMocks();
		backup.buildBackupExport.mockResolvedValue({
			formatVersion: 1,
			transactions: Array.from({ length: 150 }, (_, i) => ({ id: `tx-${i}` }))
		});
		await GET({
			locals: { user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' } }
		} as never);
		expect(
			logWriter.log.mock.calls
				.map(([line]) => line as { event: string })
				.filter((line) => line.event === 'sensitive_read')
		).toEqual([
			{
				event: 'sensitive_read',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym('user-a'),
					'budgetpilot.data.export': 'backup',
					'budgetpilot.data.scope': 'account_records',
					'budgetpilot.data.transactions_exported': '100-999'
				}
			}
		]);
	});
});
