import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclaredCurrencyMismatchError } from './declaredCurrency';

const persist = vi.hoisted(() => ({
	createImportBatch: vi.fn(),
	persistImportedTransactions: vi.fn()
}));

vi.mock('./persist', async (importOriginal) => ({
	...(await importOriginal<typeof import('./persist')>()),
	createImportBatch: persist.createImportBatch,
	persistImportedTransactions: persist.persistImportedTransactions
}));

const { ImportWriteError } = await import('./persist');
const { classifyWriteFailure, writeImport } = await import('./writeImport');

const MISMATCH = {
	code: 'declared-currency-mismatch' as const,
	declared: 'USD',
	destination: 'EUR'
};

/**
 * The route-facing half of D3: every way the write step can fail, mapped to what the SCREEN may say
 * about it. The sentences are in `$lib/i18n/importWriteLabel.ts`; this file decides which one.
 *
 * The rule each case below holds: never say more than is known. « Nothing was saved » only where
 * nothing can have been, a count only where the ledger answered, and « may have been » everywhere
 * else, including for an error this module has never seen.
 */
describe('classifyWriteFailure', () => {
	it('keeps the currency refusal as the fact the route already renders', () => {
		expect(classifyWriteFailure(new DeclaredCurrencyMismatchError(MISMATCH))).toEqual({
			kind: 'currency',
			fact: MISMATCH
		});
	});

	it('says nothing was saved for a reference that did not resolve', () => {
		expect(classifyWriteFailure(new ImportWriteError({ kind: 'not-found' }))).toEqual({
			kind: 'nothing-saved'
		});
	});

	it('says nothing was saved when the ledger holds 0 rows for the batch', () => {
		expect(classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: 0 }))).toEqual({
			kind: 'nothing-saved'
		});
	});

	it('names the count when the ledger holds some rows', () => {
		expect(classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: 3 }))).toEqual({
			kind: 'partly-saved',
			landedRows: 3
		});
	});

	it('says rows may have been saved when the ledger could not be read', () => {
		expect(
			classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: null }))
		).toEqual({ kind: 'maybe-saved' });
	});

	it('says rows may have been saved for an error it does not recognise, never « nothing »', () => {
		// Fails SAFE. `persistImportedTransactions` wraps every throw today, so this branch is reached
		// only by a future writer that does not; « nothing was saved » there would be a guess.
		expect(classifyWriteFailure(new Error('connection reset'))).toEqual({ kind: 'maybe-saved' });
	});
});

describe('writeImport', () => {
	const batch = {
		userId: 'user-a',
		accountId: 'account-a',
		source: 'csv',
		fileName: 'releve.csv',
		profile: 'generic',
		rowCount: 1,
		invalidRows: 0,
		period: { from: null, to: null }
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('says nothing was saved when the batch itself could not be created, and writes no row', async () => {
		// A raw error from `createImportBatch` is the one raw error this module classifies itself:
		// no batch id exists, so no row can have been filed under one.
		persist.createImportBatch.mockRejectedValueOnce(new Error('connection reset'));

		const outcome = await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		expect(outcome).toEqual({ ok: false, failure: { kind: 'nothing-saved' } });
		expect(persist.persistImportedTransactions).not.toHaveBeenCalled();
	});

	it('carries the persist step’s count out as partly-saved', async () => {
		persist.createImportBatch.mockResolvedValueOnce('batch-1');
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 2 })
		);

		const outcome = await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		expect(outcome).toEqual({ ok: false, failure: { kind: 'partly-saved', landedRows: 2 } });
	});

	it('logs the failure without the cause’s message, which can quote a user’s rows', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		persist.createImportBatch.mockResolvedValueOnce('batch-1');
		const cause = Object.assign(new Error('Invalid value for label: CARTE SUPERETTE FICTIVE'), {
			code: 'P2000'
		});
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 2 }, { cause })
		);

		await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		const logged = error.mock.calls.map((call) => call.join(' ')).join('\n');
		// CALIBRATION: something was logged, and it names the code an operator can look up.
		expect(logged).toContain('P2000');
		expect(logged).not.toContain('SUPERETTE');
	});

	it('returns the batch and the persisted figures on success', async () => {
		persist.createImportBatch.mockResolvedValueOnce('batch-1');
		const persisted = {
			importedRows: 1,
			duplicateRows: 0,
			importedDebitCents: 100,
			importedCreditCents: 0,
			importedTransactionIds: ['t1'],
			autoCategorizedRows: 0
		};
		persist.persistImportedTransactions.mockResolvedValueOnce(persisted);

		const outcome = await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		expect(outcome).toEqual({ ok: true, batchId: 'batch-1', persisted });
	});
});
