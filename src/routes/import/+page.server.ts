import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import {
	importFirstDataRow,
	importHeaderCells,
	importSampleCoverage,
	importSampleValues,
	parseCsvTransactionRows
} from '$lib/server/import/csv';
import { applyColumnMapping } from '$lib/server/import/mapping/apply';
import { readColumnMapping, recordColumnMappingUse } from '$lib/server/import/mapping/store';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import {
	buildInvalidRowDetails,
	getHiddenInvalidRowsCount,
	type ImportInvalidRowDetail
} from '$lib/server/import/invalidRowDetails';
// Re-exported: this type was declared here and `page.server.spec.ts` names it from this module.
export type { ImportInvalidRowDetail } from '$lib/server/import/invalidRowDetails';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';
import { isLinkableNetWorthAccountType } from '$lib/domain/netWorth';
import { readLinkableNetWorthAccounts, readNetWorthAccounts } from '$lib/server/net-worth/service';
import type { PageServerLoad } from './$types';

const IMPORT_MAX_BYTES = 256_000;
const CSV_ACCOUNT_NAME = 'Compte import CSV';
/**
 * Sources an import CSV row can land on, based on the auto-detected profile (see
 * getImportSource below). The exact one is only known after the file is uploaded and its
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
		// profile could still be a first import. It's only hidden once every possible
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
			return fail(400, {
				error: m.import_error_invalid_net_worth_account(),
				designation: undefined
			});
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

		// A mapping this user designated for this exact header shape, if there is one.
		//
		// Resolved HERE rather than inside the parser: `parseCsvTransactions` reaching Prisma is
		// what made it unbundlable and put every profile parser out of a fuzzer's reach. The
		// database stays at the route and the parser stays a pure function of its input.
		//
		// `readColumnMapping` is scoped by `user.id`, always. The fingerprint is derived from a
		// bank's PUBLIC column names, so every user of that bank shares one: a lookup without the
		// owner would read another user's configuration, and that is the designed behaviour of the
		// key rather than a rare collision.
		const headerCells = importHeaderCells(importData.rows);
		const remembered =
			headerCells.length === 0 ? null : await readColumnMapping(user.id, headerCells);
		const verdict = remembered ? applyColumnMapping(remembered, headerCells) : null;

		// Only `recognised` parses through the mapping. `partial` and `lost` are the plate's states
		// 3b and 3c, which belong to the designation screen: until it exists they fall through to
		// today's behaviour rather than refusing, so a bank that renames a column costs the user
		// exactly what it costs them today and not more.
		const useMapping = verdict?.kind === 'recognised';

		const result = parseCsvTransactionRows(importData.rows, {
			maxBytes: IMPORT_MAX_BYTES,
			profile: useMapping ? 'mapped' : 'auto',
			columnMapping: useMapping ? remembered! : undefined,
			sourceName: importFile.name || importData.kind,
			categorizationRules: categorizationRules.map((rule) => ({
				...rule,
				type: rule.type === 'income' || rule.type === 'expense' ? rule.type : 'any'
			}))
		});

		if (result.transactions.length === 0) {
			return fail(400, {
				error: m.import_error_no_valid_transactions(),
				// The file nothing recognised, offered to the designation screen rather than left as
				// a refusal. Only when the refusal is ABOUT the columns: a file refused for a
				// currency it cannot hold, or for amounts whose sign lives in another column, is not
				// a file the user can repair by naming columns, and offering the screen there would
				// send them to do work that cannot help.
				designation: offersDesignation(result, headerCells)
					? {
							name: importFile.name,
							headers: headerCells,
							samples: importSampleValues(importData.rows),
							coverage: importSampleCoverage(importData.rows),
							firstRow: importFirstDataRow(importData.rows),
							rowCount: Math.max(0, result.summary.totalRows),
							hasHeaderRow: true
						}
					: undefined,
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

		// Counted only once the file actually produced transactions, and only for the mapping that
		// parsed it. A file refused by every row still "used" the mapping in some sense, and the
		// recap sentence this feeds says « utilisée N fois » about a designation that WORKED, so
		// counting a refusal there would overstate how much the user should trust it.
		if (useMapping && remembered) await recordColumnMappingUse(user.id, remembered.id);

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

/**
 * Whether this refusal is one the designation screen can repair.
 *
 * The two states it separates: a file nothing recognised, and a file recognised and then refused on
 * its CONTENT. Only the first is a column problem. Sending a user to name columns on a GBP file, or
 * on one whose amounts are magnitudes beside a debit/credit indicator, is work that cannot succeed
 * and ends with them believing the feature is broken.
 *
 * Read from the refusal CODE rather than from "the parse produced nothing", because nearly every
 * refusal produces nothing.
 */
function offersDesignation(
	result: ReturnType<typeof parseCsvTransactionRows>,
	headerCells: string[]
): boolean {
	if (headerCells.length === 0) return false;
	return result.invalidRows.some((row) => row.fact.code === 'missing-required-column');
}

const INVALID_NET_WORTH_ACCOUNT = Symbol('invalid-net-worth-account');

/**
 * Validates the client-submitted destination account against the user's own active, linkable
 * NetWorthAccounts (never trust a client-supplied foreign key blindly, see CLAUDE.md). An
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
	if (err.code === 'expands_too_far') {
		// Megabytes rather than bytes: the figures here are in the millions, and the number the
		// user can act on is "how much bigger than allowed", not the exact byte count.
		return m.import_error_expands_too_far({
			size: Math.ceil((err.params?.size ?? 0) / 1_000_000),
			max: Math.floor((err.params?.max ?? 0) / 1_000_000)
		});
	}
	if (err.code === 'bad_extension') return m.import_error_bad_extension();
	return m.import_error_empty_file();
}
