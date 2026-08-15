import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { importHeaderCells, parseCsvTransactionRows } from '$lib/server/import/csv';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import { mappingFromPostedIndices } from '$lib/server/import/mapping/designation';
import { fingerprintFor } from '$lib/server/import/mapping/fingerprint';
import { saveColumnMapping } from '$lib/server/import/mapping/store';
import { MAPPING_ROLES } from '$lib/server/import/mapping/model';
import {
	buildInvalidRowDetails,
	getHiddenInvalidRowsCount
} from '$lib/server/import/invalidRowDetails';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';

const IMPORT_MAX_BYTES = 256_000;
const CSV_ACCOUNT_NAME = 'Compte import CSV';

/**
 * The import the designation screen submits, and the ONE place its choices become facts.
 *
 * ## Everything that decides anything is re-derived here
 *
 * ASVS 5.0 **V8.3.1**. The browser posts the FILE and four INDICES. This action re-reads the file,
 * re-derives its own header list, and resolves every index against that list. It never reads a
 * column name, a column count or a header flag from the request, because each of those is a value
 * an attacker would want to move and none of them is cheaper to trust than to recompute.
 *
 * The four indices are the only client input that survives, and `mappingFromPostedIndices` is where
 * they are validated: positively, against the closed role set and against the real column count.
 *
 * ## Every read and write is scoped by `userId`
 *
 * **V8.x**, and it is stated because the fingerprint invites the opposite. A fingerprint is a hash
 * of a bank's PUBLIC column names, so every customer of that bank shares one: a lookup keyed on it
 * alone would read another user's configuration, and that is the designed behaviour of a shape key
 * rather than a rare collision. `saveColumnMapping` takes the owner as its first argument for the
 * same reason.
 *
 * ## What this action does not decide
 *
 * It does not bound or sanitise the stored column names, and it must not: `saveColumnMapping` does
 * that for every write path at once, including the restore path, which is the one that bypassed the
 * service last time this repository shipped an invariant in "the" write path.
 */
export const actions: Actions = {
	default: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const importFile = formData.get('csvFile');

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

		let importData;
		try {
			importData = await readImportFile(importFile, { maxBytes: IMPORT_MAX_BYTES });
		} catch (caught) {
			if (caught instanceof ImportFileError)
				return fail(400, { error: m.import_error_empty_file() });
			throw caught;
		}
		if (importData.rows.length === 0) {
			return fail(400, { error: m.import_error_empty_file() });
		}

		// THE server's own header list. Read from the file this request carried, through the same
		// helper the parser resolves against, so the bytes designated are the bytes parsed.
		const headers = importHeaderCells(importData.rows);
		const hasHeaderRow = formData.get('hasHeaderRow') !== 'false';

		const resolved = mappingFromPostedIndices({
			headers,
			posted: Object.fromEntries(
				// Read from the closed role set rather than from the form's own keys: a posted field
				// the application does not know is never looked at, which is V2.2.1 as a property of
				// the loop rather than as a rejection.
				MAPPING_ROLES.map((role) => [role, asString(formData.get(`${role}Index`))])
			),
			hasHeaderRow
		});
		if (!resolved.ok) {
			return fail(400, { error: m.import_columns_error_invalid_designation() });
		}

		const categorizationRules = await prisma.categorizationRule.findMany({
			where: { userId: user.id, active: true },
			select: { id: true, pattern: true, targetCategory: true, type: true, active: true },
			orderBy: { createdAt: 'asc' }
		});

		const result = parseCsvTransactionRows(importData.rows, {
			maxBytes: IMPORT_MAX_BYTES,
			profile: 'mapped',
			columnMapping: resolved.mapping,
			sourceName: importFile.name || importData.kind,
			categorizationRules: categorizationRules.map((rule) => ({
				...rule,
				type: rule.type === 'income' || rule.type === 'expense' ? rule.type : 'any'
			}))
		});

		if (result.transactions.length === 0) {
			// Back to the screen with the designations intact rather than to the upload. The user's
			// answer may be right and the file wrong, and making them re-upload to find out is how a
			// correctable mistake becomes a reason to give up.
			return fail(400, { error: m.import_error_no_valid_transactions(), keepDesignation: true });
		}

		// Memorised by default, and only once the file actually produced transactions. A mapping
		// remembered from a parse that yielded nothing is a promise about a shape we have not
		// actually read successfully.
		let capReached = false;
		if (formData.get('remember') !== 'false') {
			const saved = await saveColumnMapping(
				user.id,
				fingerprintFor(headers, resolved.mapping.matchBy),
				resolved.mapping
			);
			// A refusal to REMEMBER never refuses the IMPORT: the user asked to import a file, and
			// the memorisation is a convenience attached to it. The cap is reported and the rows land.
			if (!saved.ok && saved.reason.code === 'cap-reached') capReached = true;
		}

		const bucket = await resolveImportBucketAccount({
			userId: user.id,
			name: CSV_ACCOUNT_NAME,
			source: 'csv',
			netWorthAccountId: null
		});
		const batchId = await createImportBatch({
			userId: user.id,
			source: 'csv',
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
			source: 'csv',
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
				// The rejected rows themselves, not only their count. This route used to return the
				// count alone, so a designated import could reject rows and name none of them — on the
				// one run where the user had just chosen the columns and could still tell a wrong
				// choice from a bad file. Same shape as `/import` so one panel draws both (#338).
				invalidRowDetails: buildInvalidRowDetails(importData.previewRowsByLine, result),
				hiddenInvalidRowsCount: getHiddenInvalidRowsCount(result.summary.invalidRows),
				// Always null here: the destination-account choice belongs to the upload form, which
				// this route does not carry. Present so the payload is one shape rather than two.
				netWorthLinkStatus: null
			},
			capReached
		};
	}
};

function asString(value: FormDataEntryValue | null): string | null {
	return typeof value === 'string' ? value : null;
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
