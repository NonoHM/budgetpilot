import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeclaredCurrencyMismatchError } from './declaredCurrency';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

const persist = vi.hoisted(() => ({
	createImportBatchRow: vi.fn(),
	persistImportedTransactions: vi.fn(),
	deleteEmptyImportBatch: vi.fn(async () => true)
}));

/** The instant the batch row was created, as the database returns it. */
const CREATED_AT = new Date('2026-09-27T13:31:05.000Z');

vi.mock('./persist', async (importOriginal) => ({
	...(await importOriginal<typeof import('./persist')>()),
	createImportBatchRow: persist.createImportBatchRow,
	persistImportedTransactions: persist.persistImportedTransactions,
	deleteEmptyImportBatch: persist.deleteEmptyImportBatch
}));

const logged = vi.hoisted(() => [] as unknown[]);
// Set by one #1087 test: the `sensitive_create` line throws, as it would without the pseudonym secret.
const logFault = vi.hoisted(() => ({ on: false }));
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: { event: string }) => {
		if (logFault.on && event.event === 'sensitive_create') throw new Error('log fault');
		logged.push(event);
	}
}));

const { ImportWriteError } = await import('./persist');
const { classifyWriteFailure, writeImport } = await import('./writeImport');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');

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
		expect(classifyWriteFailure(new DeclaredCurrencyMismatchError(MISMATCH), CREATED_AT)).toEqual({
			kind: 'currency',
			fact: MISMATCH
		});
	});

	it('says nothing was saved for a reference that did not resolve', () => {
		expect(classifyWriteFailure(new ImportWriteError({ kind: 'not-found' }), CREATED_AT)).toEqual({
			kind: 'nothing-saved'
		});
	});

	it('says nothing was saved when the ledger holds 0 rows for the batch', () => {
		expect(
			classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: 0 }), CREATED_AT)
		).toEqual({
			kind: 'nothing-saved'
		});
	});

	it('names the count when the ledger holds some rows', () => {
		expect(
			classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: 3 }), CREATED_AT)
		).toEqual({
			kind: 'partly-saved',
			landedRows: 3,
			createdAt: CREATED_AT.toISOString()
		});
	});

	it('says rows may have been saved when the ledger could not be read', () => {
		expect(
			classifyWriteFailure(new ImportWriteError({ kind: 'failed', landedRows: null }), CREATED_AT)
		).toEqual({ kind: 'maybe-saved' });
	});

	it('says rows may have been saved for an error it does not recognise, never « nothing »', () => {
		// Fails SAFE. `persistImportedTransactions` wraps every throw today, so this branch is reached
		// only by a future writer that does not; « nothing was saved » there would be a guess.
		expect(classifyWriteFailure(new Error('connection reset'), CREATED_AT)).toEqual({
			kind: 'maybe-saved'
		});
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
		logged.length = 0;
	});

	it('says nothing was saved when the batch itself could not be created, and writes no row', async () => {
		// A raw error from `createImportBatch` is the one raw error this module classifies itself:
		// no batch id exists, so no row can have been filed under one.
		persist.createImportBatchRow.mockRejectedValueOnce(new Error('connection reset'));

		const outcome = await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		expect(outcome).toEqual({ ok: false, failure: { kind: 'nothing-saved' } });
		expect(persist.persistImportedTransactions).not.toHaveBeenCalled();
	});

	it('carries the persist step’s count out as partly-saved', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 2 })
		);

		const outcome = await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		// The batch's own instant rides with the count, as an ISO string the page formats (D3).
		expect(outcome).toEqual({
			ok: false,
			failure: { kind: 'partly-saved', landedRows: 2, createdAt: CREATED_AT.toISOString() }
		});
	});

	it('logs the failure without the cause’s message, which can quote a user’s rows', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		const cause = Object.assign(new Error('Invalid value for label: CARTE SUPERETTE FICTIVE'), {
			code: 'P2000'
		});
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 2 }, { cause })
		);

		await writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

		// The whole event: it names the code an operator can look up, and nothing carries the
		// cause's message. The import's own `sensitive_create` line is asserted below.
		expect(
			(logged as { event: string }[]).filter((line) => line.event === EVENT.importWriteFailed)
		).toEqual([
			{
				event: EVENT.importWriteFailed,
				attributes: {
					[ATTRIBUTE.errorType]: 'ImportWriteError',
					[ATTRIBUTE.importStage]: 'rows',
					[ATTRIBUTE.importLandedRows]: 2,
					[ATTRIBUTE.causeType]: 'Error',
					[ATTRIBUTE.causeCode]: 'P2000'
				}
			}
		]);
		expect(JSON.stringify(logged)).not.toContain('SUPERETTE');
	});

	it('returns the batch and the persisted figures on success', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
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

/**
 * #1087: every call writes one `sensitive_create` `import_file`, whatever the outcome, because
 * `/import` may have created the destination account before the write and a category can land
 * before a row insert fails. The count is the ledger's answer: the rows written, the rows a failure
 * left, `0` where nothing can have landed, `unknown` where the ledger could not be read. Wire names
 * as literals, so a renamed constant cannot carry the assertion with it.
 */
describe('#1087: writeImport writes sensitive_create import_file', () => {
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
	const creates = () =>
		(logged as { event: string }[]).filter((line) => line.event === 'sensitive_create');
	const line = (created: string) => ({
		event: 'sensitive_create',
		attributes: {
			'budgetpilot.user.pseudonym': logUserPseudonym('user-a'),
			'budgetpilot.data.operation': 'import_file',
			'budgetpilot.data.scope': 'import',
			'budgetpilot.data.transactions_created': created
		}
	});
	const run = () => writeImport({ batch, transactions: [], parseDuplicateRows: 0 });

	beforeEach(() => {
		vi.clearAllMocks();
		logged.length = 0;
	});

	it('counts the rows written on success', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockResolvedValueOnce({
			importedRows: 12,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0,
			importedTransactionIds: [],
			autoCategorizedRows: 0
		});
		await run();
		expect(creates()).toEqual([line('10-99')]);
	});

	// Separates « counted from the ledger » from « the success figure or nothing ».
	it('counts the rows a failure left', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 3 })
		);
		await run();
		expect(creates()).toEqual([line('2-9')]);
	});

	it('says unknown when the ledger could not be read', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: null })
		);
		await run();
		expect(creates()).toEqual([line('unknown')]);
	});

	// Separates « one line per call » from « a line only when rows landed ».
	it('writes 0 when the batch itself was refused', async () => {
		persist.createImportBatchRow.mockRejectedValueOnce(new Error('connection reset'));
		await run();
		expect(creates()).toEqual([line('0')]);
	});

	// Separates « a log fault surfaces as itself » from « a log fault is read as a failed write »: inside
	// the write's `catch`, it was classified `maybe-saved` and logged as a failed `rows` stage, a
	// statement about the ledger made by the logger.
	it('a line that throws after a written import is not read as a failed write', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockResolvedValueOnce({
			importedRows: 1,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0,
			importedTransactionIds: [],
			autoCategorizedRows: 0
		});
		logFault.on = true;
		try {
			await expect(run()).rejects.toThrow('log fault');
		} finally {
			logFault.on = false;
		}
		expect(
			(logged as { event: string }[]).filter(
				(line) => line.event === 'budgetpilot.import.write_failed'
			)
		).toEqual([]);
	});

	it('writes 0 on a currency refusal', async () => {
		persist.createImportBatchRow.mockResolvedValueOnce({ id: 'batch-1', createdAt: CREATED_AT });
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new DeclaredCurrencyMismatchError(MISMATCH)
		);
		await run();
		expect(creates()).toEqual([line('0')]);
	});
});
