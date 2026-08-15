import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { importHeaderCells, parseCsvTransactionRows } from '$lib/server/import/csv';
import { applyColumnMapping } from '$lib/server/import/mapping/apply';
import { readColumnMapping, recordColumnMappingUse } from '$lib/server/import/mapping/store';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import type { CsvRefusalFact, CsvRefusalScope } from '$lib/server/import/refusals';
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

/**
 * Exported so the spec can name the shape instead of retyping it. It used to be declared by
 * hand in two places there, which is a copy certifying the original: the two could drift by
 * exactly the field that matters and the comparison would still pass.
 */
export interface ImportInvalidRowDetail {
	/**
	 * Identity for the render's keyed each block, and nothing else.
	 *
	 * It used to be the line number, which worked only because header level complaints were
	 * given an invented `index + 1` (#291). Removing that invention without changing the key
	 * would give every header complaint the same key, which is a runtime crash rather than a
	 * type error, because the dependency lives in markup. A position in this list is stable:
	 * it is never reordered or filtered on the client.
	 */
	key: number;
	scope: CsvRefusalScope;
	fact: CsvRefusalFact;
	/** Absent when the refusal names no field. Never defaulted: the scope carries what the old `?? 'ligne'` fallback used to imply. */
	field?: string;
	profile: string;
	preview: string;
}

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

function buildInvalidRowDetails(
	previewRowsByLine: Record<number, string[]>,
	result: ReturnType<typeof parseCsvTransactionRows>
): ImportInvalidRowDetail[] {
	return result.invalidRows.slice(0, INVALID_ROW_DETAIL_LIMIT).map((row, index) => ({
		key: index,
		scope: row.scope,
		fact: row.fact,
		field: row.field,
		profile: result.summary.profile,
		// Only a row scoped refusal has a row to preview. A header or file scoped one gets an
		// empty preview rather than `anonymizeCsvRowPreview([])`, which returns « ligne vide »
		// and would assert the file had an empty line there. Before #291 these carried invented
		// lines and so pulled a real transaction's cells into a complaint about the header.
		preview:
			row.scope.kind === 'row'
				? anonymizeCsvRowPreview(previewRowsByLine[row.scope.line] ?? [])
				: ''
	}));
}

function getHiddenInvalidRowsCount(invalidRows: number): number {
	return Math.max(0, invalidRows - INVALID_ROW_DETAIL_LIMIT);
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

function anonymizeCsvRowPreview(cells: string[]): string {
	const preview = cells
		.map((cell) => anonymizeImportCell(cell))
		.filter(Boolean)
		.slice(0, 8)
		.join(' | ');

	// Through the catalogue, not as a literal. This string is rendered straight into the invalid
	// rows table, so a hardcoded French one is the same defect the refusal contract removes from
	// the parsers, one layer out: an English user was shown French. The French output is
	// unchanged, byte for byte.
	return preview || m.import_invalid_preview_empty();
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
