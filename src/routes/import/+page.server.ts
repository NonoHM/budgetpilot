import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { parseCsvTransactionRows } from '$lib/server/import/csv';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import {
	anonymizeImportCell,
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';
import { isLinkableNetWorthAccountType } from '$lib/domain/netWorth';
import { readLinkableNetWorthAccounts, readNetWorthAccounts } from '$lib/server/net-worth/service';
import type { PageServerLoad } from './$types';

const IMPORT_MAX_BYTES = 256_000;
const CSV_ACCOUNT_NAME = 'Compte import CSV';
const INVALID_ROW_DETAIL_LIMIT = 20;

interface ImportInvalidRowDetail {
	lineNumber: number;
	reason: string;
	field: string;
	profile: string;
	preview: string;
}

/**
 * Sources an import CSV row can land on, based on the auto-detected profile (see
 * getImportSource below) — the exact one is only known after the file is uploaded and its
 * profile detected, so the selector's visibility can't be decided from a single source.
 */
const CSV_IMPORT_SOURCES = ['csv', 'revolut', 'banque_populaire'] as const;

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const [linkableNetWorthAccounts, existingImportBuckets] = await Promise.all([
		readLinkableNetWorthAccounts(user.id),
		prisma.account.findMany({
			where: { userId: user.id, name: CSV_ACCOUNT_NAME, source: { in: [...CSV_IMPORT_SOURCES] } },
			select: { source: true }
		})
	]);
	const existingImportSources = existingImportBuckets.map((account) => account.source);

	return {
		linkableNetWorthAccounts,
		// The destination-account selector only has an effect the very first time a given
		// profile's bucket is created (see the `update: {}` no-op below). Since the exact
		// profile isn't known before upload, the selector stays visible as long as ANY
		// profile could still be a first import — it's only hidden once every possible
		// bucket already exists, at which point selecting a destination would always be a
		// no-op regardless of the uploaded file.
		hasAllImportBucketsExisting: CSV_IMPORT_SOURCES.every((source) =>
			existingImportSources.includes(source)
		)
	};
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const importFile = formData.get('csvFile');
		const netWorthAccountId = await resolveNetWorthAccountId(user.id, formData);
		if (netWorthAccountId === INVALID_NET_WORTH_ACCOUNT) {
			return fail(400, { error: m.import_error_invalid_net_worth_account() });
		}

		if (!isUploadedFile(importFile) || importFile.size === 0) {
			return fail(400, { error: m.import_error_no_file() });
		}

		if (!isSupportedImportFile(importFile.name)) {
			return fail(400, { error: m.import_error_bad_extension() });
		}

		if (importFile.size > IMPORT_MAX_BYTES) {
			return fail(400, {
				error: m.import_error_too_large({ size: importFile.size, max: IMPORT_MAX_BYTES })
			});
		}

		const importData = await readUploadedImportFile(importFile);
		if ('error' in importData) return fail(400, { error: importData.error });
		if (importData.rows.length === 0) {
			return fail(400, { error: m.import_error_empty_file() });
		}
		const categorizationRules = await prisma.categorizationRule.findMany({
			where: { userId: user.id, active: true },
			select: {
				id: true,
				pattern: true,
				targetCategory: true,
				type: true,
				active: true
			},
			orderBy: { createdAt: 'asc' }
		});

		const result = parseCsvTransactionRows(importData.rows, {
			maxBytes: IMPORT_MAX_BYTES,
			profile: 'auto',
			sourceName: importFile.name || importData.kind,
			categorizationRules: categorizationRules.map((rule) => ({
				...rule,
				type: rule.type === 'income' || rule.type === 'expense' ? rule.type : 'any'
			}))
		});

		if (result.transactions.length === 0) {
			return fail(400, {
				error: m.import_error_no_valid_transactions(),
				importResult: buildImportResult(
					result.summary.totalRows,
					0,
					result.summary.duplicateRows,
					result.summary.invalidRows,
					0,
					0,
					buildInvalidRowDetails(importData.previewRowsByLine, result),
					getHiddenInvalidRowsCount(result.summary.invalidRows)
				)
			});
		}

		const source = getImportSource(result.summary.profile);
		const bucket = await resolveImportBucketAccount({
			userId: user.id,
			name: CSV_ACCOUNT_NAME,
			source,
			netWorthAccountId
		});
		// Tells the user whether their destination-account choice was actually applied or
		// silently ignored because a bucket for this exact profile already existed.
		const netWorthLinkStatus: 'applied' | 'ignored' | null =
			netWorthAccountId === null ? null : bucket.created ? 'applied' : 'ignored';
		const batchId = await createImportBatch({
			userId: user.id,
			source,
			fileName: importFile.name,
			profile: result.summary.profile,
			rowCount: result.summary.totalRows,
			invalidRows: result.summary.invalidRows,
			period: result.summary.period
		});

		const persisted = await persistImportedTransactions({
			userId: user.id,
			accountId: bucket.accountId,
			importBatchId: batchId,
			source,
			transactions: result.transactions,
			parseDuplicateRows: result.summary.duplicateRows
		});

		return {
			importResult: {
				fileName: importFile.name,
				profile: result.summary.profile,
				totalRows: result.summary.totalRows,
				importedRows: persisted.importedRows,
				invalidRows: result.summary.invalidRows,
				duplicateRows: persisted.duplicateRows,
				totalDebitCents: persisted.importedDebitCents,
				totalCreditCents: persisted.importedCreditCents,
				period: result.summary.period,
				batchId,
				invalidRowDetails: buildInvalidRowDetails(importData.previewRowsByLine, result),
				hiddenInvalidRowsCount: getHiddenInvalidRowsCount(result.summary.invalidRows),
				netWorthLinkStatus
			}
		};
	}
};

function buildImportResult(
	totalRows: number,
	importedRows: number,
	duplicateRows: number,
	invalidRows: number,
	totalDebitCents: number,
	totalCreditCents: number,
	invalidRowDetails: ImportInvalidRowDetail[] = [],
	hiddenInvalidRowsCount = 0
) {
	return {
		totalRows,
		importedRows,
		duplicateRows,
		invalidRows,
		totalDebitCents,
		totalCreditCents,
		invalidRowDetails,
		hiddenInvalidRowsCount
	};
}

function buildInvalidRowDetails(
	previewRowsByLine: Record<number, string[]>,
	result: ReturnType<typeof parseCsvTransactionRows>
): ImportInvalidRowDetail[] {
	return result.invalidRows.slice(0, INVALID_ROW_DETAIL_LIMIT).map((row) => ({
		lineNumber: row.line,
		reason: row.reason,
		field: row.field ?? 'ligne',
		profile: result.summary.profile,
		preview: anonymizeCsvRowPreview(previewRowsByLine[row.line] ?? [])
	}));
}

function getHiddenInvalidRowsCount(invalidRows: number): number {
	return Math.max(0, invalidRows - INVALID_ROW_DETAIL_LIMIT);
}

const INVALID_NET_WORTH_ACCOUNT = Symbol('invalid-net-worth-account');

/**
 * Validates the client-submitted destination account against the user's own active, linkable
 * NetWorthAccounts (never trust a client-supplied foreign key blindly — see CLAUDE.md). An
 * empty selection ("Aucun") is valid and means null. An id that doesn't resolve to one of the
 * user's own accounts is rejected rather than silently ignored.
 */
async function resolveNetWorthAccountId(
	userId: string,
	formData: FormData
): Promise<string | null | typeof INVALID_NET_WORTH_ACCOUNT> {
	const raw = formData.get('netWorthAccountId');
	if (typeof raw !== 'string' || raw === '') return null;

	const accounts = await readNetWorthAccounts(userId);
	const match = accounts.find(
		(account) => account.id === raw && isLinkableNetWorthAccountType(account.type)
	);
	return match ? match.id : INVALID_NET_WORTH_ACCOUNT;
}

function getImportSource(profile: string): string {
	if (profile === 'banque-populaire') return 'banque_populaire';
	if (profile === 'revolut') return 'revolut';
	return 'csv';
}

function anonymizeCsvRowPreview(cells: string[]): string {
	const preview = cells
		.map((cell) => anonymizeImportCell(cell))
		.filter(Boolean)
		.slice(0, 8)
		.join(' | ');

	return preview || 'ligne vide';
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		'size' in value &&
		'text' in value &&
		typeof value.name === 'string' &&
		typeof value.size === 'number' &&
		typeof value.text === 'function'
	);
}

async function readUploadedImportFile(file: File) {
	try {
		return await readImportFile(file, { maxBytes: IMPORT_MAX_BYTES });
	} catch (caught) {
		if (caught instanceof ImportFileError) return { error: importFileErrorMessage(caught) };
		throw caught;
	}
}

function importFileErrorMessage(err: ImportFileError): string {
	if (err.code === 'too_large') {
		return m.import_error_too_large({ size: err.params?.size ?? 0, max: err.params?.max ?? 0 });
	}
	if (err.code === 'bad_extension') return m.import_error_bad_extension();
	return m.import_error_empty_file();
}
