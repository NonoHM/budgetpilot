import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { importHeaderCells, parseCsvTransactionRows } from '$lib/server/import/csv';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import { mappingFromPostedIndices } from '$lib/server/import/mapping/designation';
import { fingerprintFor } from '$lib/server/import/mapping/fingerprint';
import { recordColumnMappingUse, saveColumnMapping } from '$lib/server/import/mapping/store';
import { MAPPING_ROLES } from '$lib/server/import/mapping/model';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import {
	buildInvalidRowDetails,
	getHiddenInvalidRowsCount
} from '$lib/server/import/invalidRowDetails';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from '$lib/server/import/persist';
import { describeIncomingBatch, findCollidingBatch } from '$lib/server/import/collision';

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
			// The user's answer, carried into the PARSE and not only into the mapping. Without it
			// the parser consumed row 0 as a header on a file that has none, losing one
			// transaction per import in silence. See `server/import/headerlessFile.spec.ts`.
			hasHeaderRow,
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
			//
			// AND THE REASON, when the file was refused as a whole. « Aucune transaction valide à
			// importer » is true and useless: it is the same sentence a user gets for a missing date
			// column, so it leaves them re-designating at random. A header-scoped refusal is a fact
			// about the FILE: the money is split across two columns, or the amounts are magnitudes
			// beside a direction column. Naming it is the difference between a refusal that
			// teaches and one that only blocks. Row-scoped refusals are deliberately not surfaced
			// here: sixty-six of them are a summary, not a banner. See #343.
			const headerRefusal = result.invalidRows.find((row) => row.scope.kind === 'header');
			return fail(400, {
				error: headerRefusal
					? refusalLabel(headerRefusal.fact)
					: m.import_error_no_valid_transactions(),
				keepDesignation: true
			});
		}

		/**
		 * The statement this designation appears to repeat.
		 *
		 * THIS route is where the blind usability session actually doubled its finances, and the
		 * reason it needs its own call rather than being covered by the one on `/import`. The path
		 * that doubled was not a correction: a file auto-detected and imported, then the SAME file
		 * designated by hand because the first read had put the wrong column in `label`. Nothing in
		 * that sequence sets `?correct=`, so a guard scoped to the correction path would leave the
		 * observed defect open.
		 *
		 * Before `saveColumnMapping` and before every write below it, so a run the user abandons
		 * leaves no batch, no memorised correspondance and no use counted against one.
		 */
		if (formData.get('confirmCollision') !== '1') {
			const incoming = describeIncomingBatch(result.transactions, result.summary.period);
			const collision = await findCollidingBatch(user.id, incoming);
			if (collision) {
				return fail(409, {
					collision,
					incoming: {
						fileName: importFile.name,
						periodStart: incoming.period.from,
						periodEnd: incoming.period.to,
						transactionCount: incoming.transactionCount,
						debitCents: incoming.debitCents,
						creditCents: incoming.creditCents
					},
					// The designations survive the question, exactly as they survive a refusal. The
					// user is being asked whether to import, not asked to designate again.
					keepDesignation: true
				});
			}
		}

		// Memorised by default, and only once the file actually produced transactions. A mapping
		// remembered from a parse that yielded nothing is a promise about a shape we have not
		// actually read successfully.
		/**
		 * A headerless file is designated every time and is NEVER memorised.
		 *
		 * There is nothing stable to fingerprint. The digest is taken over the cells of row 0, and
		 * for this file row 0 is a TRANSACTION: measured, the same statement in June and in July
		 * produces different digests, so a correspondance written here could never be found again.
		 * It would sit in a capped table forever, counting against a limit whose only escape is
		 * deleting it by hand.
		 *
		 * The distinction the design plate did not draw, and the one that made this look decided:
		 * a file whose headers are merely UNREADABLE has a header row that repeats identically
		 * every month, so its positional fingerprint IS stable and it is memorised by position, as
		 * the plate rules. A file with no header row at all is the other state.
		 *
		 * The fallbacks are worse rather than merely absent. Hashing the column count would
		 * collide every headerless statement of the same width into one correspondance, so a
		 * second bank's file would be read through the first's columns — which is exactly the
		 * « montants dans la colonne des dates » the plate warns about, made automatic.
		 */
		let capReached = false;
		let columnMappingId: string | null = null;
		if (hasHeaderRow && formData.get('remember') !== 'false') {
			const saved = await saveColumnMapping(
				user.id,
				fingerprintFor(headers, resolved.mapping.matchBy),
				resolved.mapping
			);
			// A refusal to REMEMBER never refuses the IMPORT: the user asked to import a file, and
			// the memorisation is a convenience attached to it. The cap is reported and the rows land.
			if (!saved.ok && saved.reason.code === 'cap-reached') capReached = true;
			// Kept on the batch so `/imports` can open the recap for THIS import rather than guess
			// which of a user's mappings read it. A user who opted out of memorisation gets no link,
			// and rightly: there is nothing memorised to correct.
			if (saved.ok) columnMappingId = saved.id;
			// The run that designates IS a use, and the recap says « utilisée N fois » out loud. A
			// mapping created at zero would tell the user, on the very screen built to let them check
			// it, that the import they are looking at never happened.
			if (saved.ok) await recordColumnMappingUse(user.id, saved.id);
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
			period: result.summary.period,
			columnMappingId
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
				// count alone, so a designated import could reject rows and name none of them, on the
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
