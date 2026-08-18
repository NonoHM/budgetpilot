import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import {
	importFirstDataRow,
	importHeaderCells,
	importSampleCoverage,
	importPreviewRows,
	importSampleValues,
	parseCsvTransactionRows
} from '$lib/server/import/csv';
import { applyColumnMapping } from '$lib/server/import/mapping/apply';
import { readColumnMapping, recordColumnMappingUse } from '$lib/server/import/mapping/store';
import { correctionMatchesFile, designationAssignment } from '$lib/server/import/mapping/recap';
import { ImportFileError, isSupportedImportFile, readImportFile } from '$lib/server/import/file';
import { detectSplitAmountPair } from '$lib/server/import/splitAmount';
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
import { describeIncomingBatch, findCollidingBatch } from '$lib/server/import/collision';
import { refusalLabel } from '$lib/i18n/refusalLabel';
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

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	// `?correct=<id>&batch=<id>` arrives from « Modifier les colonnes » on the recap.
	//
	// Both are resolved against THIS user before either is echoed into the form, and the PAIRING is
	// resolved too: the batch must be one this user owns AND one that was read through the
	// correspondance it claims. Two ids from the address bar decide which designation reopens and
	// which import a later request deletes, so an unrelated batch id must not be able to ride along
	// to the delete on the strength of a correspondance id that is genuinely the user's.
	const correctParam = url.searchParams.get('correct');
	const batchParam = url.searchParams.get('batch');
	const correcting = correctParam
		? await prisma.columnMapping.findFirst({
				where: { id: correctParam, userId: user.id },
				select: { id: true }
			})
		: null;
	// The batch is resolved SEPARATELY and may come back null while the correspondance resolves. A
	// link from before this shipped, or one whose batch has since been deleted, must still reopen
	// the designation screen: falling through to an ordinary import would read the file through the
	// very correspondance the user has just declared wrong, which is the defect this path exists to
	// prevent. It simply replaces nothing, which is exactly the behaviour that shipped before.
	const correctingBatch =
		correcting && batchParam
			? await prisma.importBatch.findFirst({
					where: { id: batchParam, userId: user.id, columnMappingId: correcting.id },
					// `createdAt` so the CONTROL can name what it destroys. « Supprimer l'ancien import »
					// names nothing once a user holds several, and this flow produces two imports of one
					// statement minutes apart as its ordinary shape. The same discriminant the delete
					// confirmation and the withheld retraction already use, so all three name one import
					// identically rather than describing it three ways.
					select: { id: true, createdAt: true }
				})
			: null;
	// What the replacement destroys BEYOND the rows, so the control can name it and can stay SILENT
	// when there is nothing to name. A warning about a loss that cannot occur is discounted every
	// time after, and then it is not read on the one run where it was true, so the app answers the
	// question rather than hedging it.
	//
	// Counted rather than fetched: only the presence of any split or tag decides the sentence, and a
	// count is what the index on `importBatchId` already serves.
	const userWorkCount = correctingBatch
		? await prisma.transaction.count({
				where: {
					userId: user.id,
					importBatchId: correctingBatch.id,
					OR: [{ splits: { some: {} } }, { tags: { some: {} } }]
				}
			})
		: 0;
	const [linkableNetWorthAccounts, existingImportBuckets] = await Promise.all([
		readLinkableNetWorthAccounts(user.id),
		prisma.account.findMany({
			where: { userId: user.id, name: CSV_ACCOUNT_NAME, source: { in: [...CSV_IMPORT_SOURCES] } },
			select: { source: true }
		})
	]);
	const existingImportSources = existingImportBuckets.map((account) => account.source);

	return {
		correction: correcting
			? {
					mappingId: correcting.id,
					batchId: correctingBatch?.id ?? null,
					// Formatted on the page, where the negotiated locale is known. Null exactly when
					// `batchId` is, so the label and the control appear and disappear together.
					replacedAt: correctingBatch?.createdAt.toISOString() ?? null,
					hasUserWork: userWorkCount > 0
				}
			: null,
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

		/**
		 * The correction path: this upload exists to REOPEN a memorised correspondance, not to import.
		 *
		 * Reached from « Modifier les colonnes » on the §3.7 recap. The file is asked for again
		 * because nothing kept it (owner ruling 2), and the screen it reopens is the plate's state 2
		 * « désignations intactes »: the user came to change one row, so the other three arrive
		 * already designated.
		 *
		 * The decision is made BEFORE the parse, and deliberately. Letting the file parse first would
		 * import it through the very mapping the user has just told us is wrong, and the correction
		 * would arrive one bad import too late. The posted id is resolved against this user's own
		 * mappings, never trusted as an id.
		 */
		const correctMappingId = formData.get('correctMappingId');
		const correctBatchId = formData.get('correctBatchId');
		const correcting =
			typeof correctMappingId === 'string' && correctMappingId.length > 0
				? await prisma.columnMapping.findFirst({
						where: { id: correctMappingId, userId: user.id }
					})
				: null;
		// The batch the correction replaces, resolved the same way and against the same pairing the
		// load used. Absent rather than refused when it does not resolve: a correction whose batch
		// cannot be verified still designates, it simply does not replace anything, which is exactly
		// today's behaviour and never a delete taken on a bad id.
		const correctingBatch =
			correcting && typeof correctBatchId === 'string' && correctBatchId.length > 0
				? await prisma.importBatch.findFirst({
						where: { id: correctBatchId, userId: user.id, columnMappingId: correcting.id },
						select: { id: true }
					})
				: null;
		// The wrong file, handed back. Refused rather than designated, and this is not fussiness: the
		// screen would open, the user would designate, and the mapping written would be a NEW one
		// under this file's fingerprint. Correct for the file they picked by mistake, and leaving the
		// correspondance they came to fix exactly where it was, with nothing anywhere saying so.
		if (correcting && !correctionMatchesFile(correcting, headerCells)) {
			return fail(400, { error: m.import_columns_correct_wrong_file() });
		}
		if (correcting) {
			return fail(400, {
				designation: {
					name: importFile.name,
					headers: headerCells,
					samples: importSampleValues(importData.rows),
					previewRows: importPreviewRows(importData.rows),
					coverage: importSampleCoverage(importData.rows),
					firstRow: importFirstDataRow(importData.rows),
					rowCount: Math.max(0, importData.rows.length - 1),
					hasHeaderRow: true
				},
				// Null per role where the remembered column is not in this file. A neighbour picked by
				// proximity would put the money column somewhere plausible and silent.
				correctingAssignment: designationAssignment(correcting, headerCells),
				// Carried into the designation screen, which is the request that will delete. Until
				// this field existed nothing survived the navigation to say the run was a correction
				// at all, which is why the collision guard fired against the very batch the user came
				// to fix.
				//
				// `deleteOldImport` is the user's answer, read from the control's hidden companion.
				//
				// TESTED POSITIVELY FOR 'true', NEVER NEGATIVELY AGAINST 'false', and the difference
				// is a delete. An unchecked box is absent from a submission, which is why the hidden
				// companion exists at all; a hand crafted or truncated request can omit BOTH, and a
				// `!== 'false'` test would then derive CONSENT from silence and destroy an import the
				// user never agreed to lose. This shipped that way for one commit.
				//
				// The two failures are not symmetric, which is what settles the direction. Deriving
				// "keep" from a lost field leaves two imports and a way to repair them; deriving
				// "delete" destroys rows with no undo. That is the same degradation argument
				// `deleteBatch.ts` uses to fix the write-then-delete ordering, applied to a default
				// rather than to a sequence.
				//
				// The control is always rendered when a batch resolved, so the ordinary flow always
				// posts a value and never relies on this default.
				correction: correctingBatch
					? {
							batchId: correctingBatch.id,
							deleteOldImport: formData.get('deleteOldImport') === 'true'
						}
					: null
			});
		}

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
			// BEFORE the designation offer, because the plate puts it there and because the shape is
			// knowable from the bytes. §1q table B: « La détection doit refuser le fichier AVANT cet
			// écran et le nommer sur /imports. » A file whose money sits in two columns cannot be
			// expressed by naming one of them, so opening the screen would be asking the user to do
			// work and telling them afterwards that it could not have helped.
			const splitPair = detectSplitAmountPair(headerCells, importData.rows);
			const splitRefusal: ImportInvalidRowDetail[] = splitPair
				? [
						{
							key: -1,
							scope: { kind: 'header' },
							fact: {
								code: 'amount-split-across-columns',
								columns: splitPair.map((name) => `« ${name} »`).join(' et ')
							},
							profile: result.summary.profile,
							preview: ''
						}
					]
				: [];

			return fail(400, {
				error: splitPair
					? refusalLabel(splitRefusal[0].fact)
					: m.import_error_no_valid_transactions(),
				// The file nothing recognised, offered to the designation screen rather than left as
				// a refusal. Only when the refusal is ABOUT the columns: a file refused for a
				// currency it cannot hold, or for amounts whose sign lives in another column, is not
				// a file the user can repair by naming columns, and offering the screen there would
				// send them to do work that cannot help.
				// `!splitPair` is the gate: everything else about the offer is unchanged.
				designation:
					!splitPair && offersDesignation(result, headerCells)
						? {
								name: importFile.name,
								headers: headerCells,
								samples: importSampleValues(importData.rows),
								previewRows: importPreviewRows(importData.rows),
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
					// The synthesised split-amount refusal is a complaint about the file too, so it is
					// counted with them rather than left out of every figure on the screen.
					result.summary.fileLevelRefusals + splitRefusal.length,
					0,
					0,
					[...splitRefusal, ...buildInvalidRowDetails(importData.previewRowsByLine, result)],
					getHiddenInvalidRowsCount(result.invalidRows.length)
				)
			});
		}

		/**
		 * The statement this run appears to repeat, read through different columns.
		 *
		 * BEFORE `recordColumnMappingUse` and before every write below it, because a run the user
		 * then abandons has to leave nothing behind: no batch, no bucket, and no use counted against
		 * the correspondance whose recap sentence says « utilisée N fois ».
		 *
		 * `server/import/collision.ts` holds the rule and the argument for each of its three terms.
		 * The one that matters at this call site is the third: the check stays silent unless
		 * deduplication is about to miss this file entirely, so it cannot fire on the ordinary
		 * re-import of an already-imported file. That run is the one every user performs, and a
		 * warning shown on it is a warning nobody reads by the third month.
		 */
		if (formData.get('confirmCollision') !== '1') {
			const incoming = describeIncomingBatch(result.transactions, result.summary.period);
			const collision = await findCollidingBatch(user.id, incoming);
			if (collision) {
				return fail(409, {
					collision,
					// The same three figures for the file in hand. They are equal to the other side's
					// by construction, and showing both is the point: the identity IS the evidence,
					// and a warning that asserts a resemblance without showing it asks to be believed.
					incoming: {
						fileName: importFile.name,
						periodStart: incoming.period.from,
						periodEnd: incoming.period.to,
						transactionCount: incoming.transactionCount,
						debitCents: incoming.debitCents,
						creditCents: incoming.creditCents
					}
				});
			}
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
			period: result.summary.period,
			// Only when the mapping actually read this file. `useMapping` is the same condition the
			// parser was given, so the link cannot claim a correspondance a different profile parsed.
			columnMappingId: useMapping ? (remembered?.id ?? null) : null
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
				fileLevelRefusals: result.summary.fileLevelRefusals,
				duplicateRows: persisted.duplicateRows,
				totalDebitCents: persisted.importedDebitCents,
				totalCreditCents: persisted.importedCreditCents,
				period: result.summary.period,
				batchId,
				invalidRowDetails: buildInvalidRowDetails(importData.previewRowsByLine, result),
				hiddenInvalidRowsCount: getHiddenInvalidRowsCount(result.invalidRows.length),
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
	fileLevelRefusals: number,
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
		fileLevelRefusals,
		totalDebitCents,
		totalCreditCents,
		invalidRowDetails,
		hiddenInvalidRowsCount
	};
}

/**
 * Refusals naming a column cannot address, so the designation screen would be work that cannot
 * succeed.
 *
 * A currency the app does not hold is a fact about the money, not about which column carries it.
 * Amounts whose sign lives in a separate column, or whose value is split across two, are shapes the
 * four closed roles cannot express: there is no column to name that would make either importable.
 * Sending a user to designate on any of these ends with them believing the feature is broken.
 */
const DESIGNATION_CANNOT_REPAIR = new Set<string>([
	'unsupported-currency',
	'amount-sign-in-separate-column',
	'amount-split-across-columns'
]);

/**
 * Whether a file that produced nothing is offered the designation screen.
 *
 * ## What this used to be, and what it cost
 *
 * It used to require a `missing-required-column` refusal, which means it only ever fired for a file
 * NOTHING recognised. A file whose headers matched a profile and whose VALUES then failed got no
 * offer at all, and the two are indistinguishable from the outside: both end on « Aucune
 * transaction valide à importer », one with a way forward and one without.
 *
 * The blind usability session ran into exactly that. Dates written `01.06.2026` were rejected on
 * all 25 rows, the headers had matched, so the rescue that exists was routed away from the file
 * that needed it. The tester abandoned the task and hand-edited the statement in a text editor.
 *
 * ## The rule now
 *
 * Offered to any import that produced no transaction, minus what it provably cannot repair. Read
 * from `every` rather than `some`: a file where one row failed on an unusable currency and the rest
 * on their dates is still a file naming a column might rescue, and it is only when EVERY refusal is
 * outside the screen's reach that the offer would be a dead end.
 *
 * A file with no data row is excluded for a different reason: the screen rests on the preview
 * (handoff §6), so there is nothing for it to show. `every` over an empty list is true, which
 * closes the no-refusal case by the same expression.
 */
function offersDesignation(
	result: ReturnType<typeof parseCsvTransactionRows>,
	headerCells: string[]
): boolean {
	if (headerCells.length === 0) return false;
	if (result.summary.totalRows === 0) return false;
	return !result.invalidRows.every((row) => DESIGNATION_CANNOT_REPAIR.has(row.fact.code));
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
