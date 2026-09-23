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
import {
	importColumnDateReadings,
	importColumnDateStates
} from '$lib/server/import/columnDateState';
import { applyColumnMapping } from '$lib/server/import/mapping/apply';
import { readColumnMapping, recordColumnMappingUse } from '$lib/server/import/mapping/store';
import { correctionMatchesFile, designationAssignment } from '$lib/server/import/mapping/recap';
import { decideAutoAccount } from '$lib/server/import/autoAccount';
import { readAccountColumnAnswer } from '$lib/server/import/discriminant';
import {
	ImportFileError,
	IMPORT_FILE_MAX_BYTES,
	isSupportedImportFile,
	readImportFile
} from '$lib/server/import/file';
import { detectSplitAmountPair } from '$lib/server/import/splitAmount';
import { refusedForBounds } from '$lib/server/import/refusals';
import { resolveZeroTransactionOffer } from '$lib/server/import/offerPrecedence';
import { readDateOrderAnswer } from '$lib/server/import/dateOrder';
import { isImportRateLimited, recordImportAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
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
	resolveImportBucketAccountBySource
} from '$lib/server/import/persist';
import { describeIncomingBatch, findCollidingBatch } from '$lib/server/import/collision';
import { buildAccountOffer, type AccountOffer } from '$lib/server/import/accountOffer';
import type { ParsedCsvRow } from '$lib/server/import/types';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import type { PageServerLoad } from './$types';
import { readAccountDisplayName } from '$lib/server/accounts/service';
import type { ImportSummaryResult } from '$lib/domain/importSummary';

/**
 * Sources an import CSV row can land on, based on the auto-detected profile (see
 * getImportSource below). The exact one is only known after the file is uploaded and its
 * profile detected, so the selector's visibility can't be decided from a single source.
 */

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
					// `importedRows` so the destructive confirmation of Planche 5c can say what it
					// removes. The primary's own count is the NEW file's rows and this is the OLD
					// import's: two different numbers, and the confirmation names both because that is
					// what a confirmation for a compound act owes its reader.
					//
					// ASVS 5.0 v5.0.0-2.2.1: the widening is a SELECTED COLUMN and not a widened where
					// clause. The lookup is still scoped by `userId` and by `columnMappingId`, so this
					// reads one more field of a batch the caller already owns.
					select: { id: true, createdAt: true, importedRows: true }
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
	return {
		correction: correcting
			? {
					mappingId: correcting.id,
					batchId: correctingBatch?.id ?? null,
					// Formatted on the page, where the negotiated locale is known. Null exactly when
					// `batchId` is, so the label and the control appear and disappear together.
					replacedAt: correctingBatch?.createdAt.toISOString() ?? null,
					replacedRows: correctingBatch?.importedRows ?? 0,
					hasUserWork: userWorkCount > 0
				}
			: null
	};
};

/**
 * The account offer, in the shape that survives the wire.
 *
 * `lastUsedAt` leaves as an ISO string rather than a `Date`, and the formatting happens on the
 * page: the negotiated locale is known there, and this repository has one expensive instance of a
 * module reaching for an ambient locale on the server. `namedAt` on this same payload already
 * follows the convention.
 */
/**
 * The cells whose two readings the screen needs, per column: the ROW's value first, then the CARD's.
 *
 * Index 0 is the first data row's cell, which is the value the Date row's line 2 prints and line 3
 * converts. Indices 1..n are `importSampleValues`'s own choices, which are what the picker's cards
 * print. They are DIFFERENT cells on a sparse column by design (`importSampleValues` picks the
 * first NON-EMPTY value per column, precisely so a sparse column does not render three blanks), so
 * converting the samples and printing them beside the row's value would show a conversion of a cell
 * the row never displayed.
 *
 * Built here rather than in the component so the raw value and its reading come from one array and
 * cannot drift apart.
 */
function dateCellsPerColumn(firstRow: string[], samples: string[][]): string[][] {
	return samples.map((values, column) => [firstRow[column] ?? '', ...values]);
}

async function accountOfferPayload(userId: string, rows: ParsedCsvRow[], source?: string) {
	return accountOfferFrom(await buildAccountOffer({ userId, rows, source }));
}

/**
 * The serialisable half of an offer, split out because two callers now hold one.
 *
 * The designation branches build the offer here; the auto path's account question is handed one
 * that `decideAutoAccount` already built to make its own decision. Rebuilding it there would run
 * the resolver twice and give the screen a second answer that nothing keeps equal to the first.
 */
function accountOfferFrom(offer: AccountOffer) {
	return {
		options: offer.options,
		resolution: offer.resolution,
		prefillName: offer.prefillName,
		memory: offer.memory && {
			useCount: offer.memory.useCount,
			lastUsedAt: offer.memory.lastUsedAt?.toISOString() ?? null
		},
		// Nobody has chosen yet on the way in. The screen derives its prefill from `resolution`.
		chosenId: null
	};
}

export const actions: Actions = {
	default: async ({ locals, request, getClientAddress }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const importFile = formData.get('csvFile');
		if (!isUploadedFile(importFile) || importFile.size === 0) {
			return fail(400, { error: m.import_error_no_file() });
		}

		if (!isSupportedImportFile(importFile.name)) {
			return fail(400, { error: m.import_error_bad_extension() });
		}

		// The reachable denial on this path is a LOOP, not one request: one upload is bounded by the
		// resource ceiling and cheap, and nothing stopped the second. Checked BEFORE the file is read,
		// so a tripped counter costs nothing to answer.
		const importIp = resolveClientAddress({ getClientAddress, request });
		if (await isImportRateLimited(user.id, importIp)) {
			return fail(429, { error: m.import_error_too_many_attempts() });
		}
		await recordImportAttempt(user.id, importIp);

		if (importFile.size > IMPORT_FILE_MAX_BYTES) {
			return fail(400, {
				error: m.import_error_too_large({ size: importFile.size, max: IMPORT_FILE_MAX_BYTES })
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
			// Computed ONCE and shared with `dateReadings` below: the two must describe the same
			// cells, or a card would print one value and convert another.
			const correctingSamples = importSampleValues(importData.rows);
			const correctingFirstRow = importFirstDataRow(importData.rows);
			return fail(400, {
				designation: {
					account: await accountOfferPayload(user.id, importData.rows),
					name: importFile.name,
					headers: headerCells,
					samples: correctingSamples,
					// 7k: the whole-column verdict ships WITH the offer, one per column, so the screen never
					// holds a state the submit could contradict and never computes one itself.
					dateStates: importColumnDateStates(importData.rows),
					// Both readings of the SAME cells the cards show, so the pair on a card can never
					// disagree with the value printed beside it.
					dateReadings: importColumnDateReadings(
						dateCellsPerColumn(correctingFirstRow, correctingSamples)
					),
					previewRows: importPreviewRows(importData.rows),
					coverage: importSampleCoverage(importData.rows),
					firstRow: correctingFirstRow,
					rowCount: Math.max(0, importData.rows.length - 1),
					detectedHeaderRow: true
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
			maxBytes: IMPORT_FILE_MAX_BYTES,
			profile: useMapping ? 'mapped' : 'auto',
			columnMapping: useMapping ? remembered! : undefined,
			sourceName: importFile.name || importData.kind,
			categorizationRules: categorizationRules.map((rule) => ({
				...rule,
				type: rule.type === 'income' || rule.type === 'expense' ? rule.type : 'any'
			})),
			// Absent until now: nothing on this route ever posted the field, because nothing could
			// ask. The reading offer below is the caller; `readDateOrderAnswer` is the same closed-set
			// validator `/import/columns` already reads its own answer through.
			dateOrder: readDateOrderAnswer(formData.get('dateOrder')),
			// #485's account-column offer below is the caller. Unlike `dateOrder`, no suppression
			// flag: this door has no prior mechanism that could have already asked the question.
			accountColumnAnswer: readAccountColumnAnswer(formData.get('accountColumnAnswer'))
		});

		if (result.transactions.length === 0) {
			// BEFORE the designation offer, because the plate puts it there and because the shape is
			// knowable from the bytes. §1q table B: « La détection doit refuser le fichier AVANT cet
			// écran et le nommer sur /imports. » A file whose money sits in two columns cannot be
			// expressed by naming one of them, so opening the screen would be asking the user to do
			// work and telling them afterwards that it could not have helped.
			//
			// NOT when the parse refused on the file's DIMENSIONS. A refusal naming the two money
			// columns cannot change the outcome for a file that is simply too big, so the work has no
			// reachable purpose there, and that is precisely the file on which it is most expensive.
			// The resource ceiling in `readImportFile` caps what this can cost; this decides whether it
			// has a reason to run at all. Two different questions, and bounding answers only the first.
			const splitPair = refusedForBounds(result)
				? null
				: detectSplitAmountPair(headerCells, importData.rows);
			// As in the correction branch: one array, shared by `samples` and `dateReadings`.
			const offerSamples = importSampleValues(importData.rows);
			const offerFirstRow = importFirstDataRow(importData.rows);
			/**
			 * THE FOURTH OFFER, #433's auto-path remainder (plate 7l). The parse door (`csv.ts`)
			 * already refused to guess: an ambiguous column under a recognised profile comes back as
			 * this ONE fact and nothing else, because `csv.ts` only reaches it when the file would
			 * otherwise have imported cleanly (structural refusals win first).
			 *
			 * `result.invalidRows.length === 1` rather than `.some`: this refusal is the WHOLE story
			 * for this parse (the door returns `emptyResult` with exactly one fact), so checking there
			 * is nothing else is free and catches a future door change that starts emitting it
			 * alongside something else, which would silently change what this offer means.
			 */
			const dateOrderRefusal =
				result.invalidRows.length === 1 &&
				result.invalidRows[0].fact.code === 'ambiguous-date-order'
					? result.invalidRows[0].fact
					: null;
			/**
			 * #485, PROVEN. The door refuses outright on a verified IBAN pair (or on a bare digit
			 * run the user has just confirmed names accounts), and there is nothing to offer beside
			 * the sentence: unlike a reading, "which account" has no answer this screen can collect
			 * that would let the file import as several accounts. Same `.length === 1` guard as
			 * `dateOrderRefusal`, same reason.
			 */
			const multiAccountRefusal =
				result.invalidRows.length === 1 && result.invalidRows[0].fact.code === 'multi-account-file'
					? result.invalidRows[0].fact
					: null;
			/**
			 * #485, UNPROVEN. The one offer this refusal DOES carry: whether the column names
			 * accounts at all. Same `.length === 1` guard, same reason.
			 */
			const accountColumnRefusal =
				result.invalidRows.length === 1 &&
				result.invalidRows[0].fact.code === 'ambiguous-account-column'
					? result.invalidRows[0].fact
					: null;
			const splitFact = splitPair
				? ({
						code: 'amount-split-across-columns',
						columns: splitPair.map((name) => `« ${name} »`).join(' et ')
					} as const)
				: null;
			const splitRefusal: ImportInvalidRowDetail[] = splitFact
				? [
						{
							key: -1,
							scope: { kind: 'header' },
							fact: splitFact,
							profile: result.summary.profile,
							preview: ''
						}
					]
				: [];

			/**
			 * THE ONE ORDER, read from `offerPrecedence.ts` rather than a ternary chain written by
			 * hand at this call site: `/import/columns` reads the SAME function below, over its own
			 * subset of these five facts, so the two doors cannot drift into two different answers
			 * for a file that raises the same pair on both.
			 */
			const offer = resolveZeroTransactionOffer({
				split: splitFact,
				multiAccount: multiAccountRefusal,
				accountColumn: accountColumnRefusal,
				dateOrder: dateOrderRefusal
			});

			return fail(400, {
				error:
					offer.rung === 'split' || offer.rung === 'multiAccount'
						? refusalLabel(offer.fact)
						: offer.rung === 'accountColumn'
							? m.import_error_ambiguous_account_column()
							: offer.rung === 'dateOrder'
								? m.import_error_ambiguous_date_order()
								: m.import_error_no_valid_transactions(),
				// The file nothing recognised, offered to the designation screen rather than left as
				// a refusal. Only when the refusal is ABOUT the columns: a file refused for a
				// currency it cannot hold, or for amounts whose sign lives in another column, is not
				// a file the user can repair by naming columns, and offering the screen there would
				// send them to do work that cannot help.
				// `offer.rung === 'generic'` is the gate: everything else about the offer is
				// unchanged. Every other rung is excluded for its own reason — `dateOrder` per plate
				// 7l (recognition covers mapping, not reading, so there is no column left to
				// redesignate), `multiAccount`/`accountColumn` one level over (naming columns cannot
				// answer "does this file cover more than one account" either) — and `resolve
				// ZeroTransactionOffer`'s order is what guarantees at most one of them is ever true.
				designation:
					offer.rung === 'generic' && offersDesignation(result, headerCells)
						? {
								account: await accountOfferPayload(
									user.id,
									importData.rows,
									// The profile IS known on this branch, unlike the correction branch above, which
									// decides before anything is parsed. It is what lets the create sheet open on
									// « Banque Populaire ···4417 » rather than on the fragment alone.
									getImportSource(result.summary.profile)
								),
								name: importFile.name,
								headers: headerCells,
								samples: offerSamples,
								// 7k: the whole-column verdict ships WITH the offer, one per column, so the screen
								// never holds a state the submit could contradict and never computes one itself.
								dateStates: importColumnDateStates(importData.rows),
								// Both readings of the SAME cells the cards show, so the pair on a card can never
								// disagree with the value printed beside it.
								dateReadings: importColumnDateReadings(
									dateCellsPerColumn(offerFirstRow, offerSamples)
								),
								previewRows: importPreviewRows(importData.rows),
								coverage: importSampleCoverage(importData.rows),
								firstRow: offerFirstRow,
								rowCount: Math.max(0, result.summary.totalRows),
								detectedHeaderRow: true
							}
						: undefined,
				// Plate 7l: opens `ColumnPicker` at `step: 'reading'` alone, no column list, no back
				// to it. `dateColumn` is the profile's OWN declared index, never a user's guess:
				// recognition already covers mapping, so this offer answers the one thing it does
				// not, the reading, and nothing about which column holds the date is in question.
				// Gated on `offer.rung`, not on `dateOrderRefusal` alone: the WINNING rung, per
				// `offerPrecedence.ts`, is what may open a dialog, never a fact that merely exists.
				reading:
					offer.rung === 'dateOrder'
						? {
								name: importFile.name,
								headers: headerCells,
								samples: offerSamples,
								dateReadings: importColumnDateReadings(
									dateCellsPerColumn(offerFirstRow, offerSamples)
								),
								firstRow: offerFirstRow,
								detectedHeaderRow: true,
								rowCount: Math.max(0, result.summary.totalRows),
								dateColumn: offer.fact.column
							}
						: undefined,
				/**
				 * #485's one offer. `column` is the index the door found evidence on; `header` and
				 * `samples` are read HERE rather than carried on the fact, same reason `dateColumn`'s
				 * sibling fields are: the fact names the evidence, the route names it for a screen.
				 * `samples` reuses `offerSamples`, chosen to DISCRIMINATE (#342) rather than the first
				 * rows, which is exactly what this question needs shown: two values that differ.
				 * Gated on `offer.rung`, same reason as `reading` above.
				 *
				 * FOUND BY A BROWSER WALK: `offerSamples` pads every column to 3 entries with `''`
				 * so the reading offer's cards can render « (vide) » for a sparse column — a
				 * convention this offer does not share, and the dialog joins `samples` with `', '`
				 * for its evidence line, so the padding rendered live as a trailing "10000001,
				 * 10000002, ". Filtered here, at the one boundary where the padded convention meets
				 * this offer's own (unpadded) contract.
				 */
				accountColumn:
					offer.rung === 'accountColumn'
						? {
								column: offer.fact.column,
								header: headerCells[offer.fact.column] ?? '',
								samples: (offerSamples[offer.fact.column] ?? []).filter((value) => value !== '')
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
		/**
		 * WHICH ACCOUNT THIS AUTO-DETECTED FILE LANDS IN, asked once and before anything is written.
		 *
		 * There is no account row on this path: `/import` imports a recognised file without ever
		 * showing the designation screen, so nothing here can ask the user. The destination used to
		 * be `(name: 'Compte import CSV', source)`, and the boot backfill renames those buckets, so
		 * that lookup silently stopped matching and made a second one. MEASURED on this branch:
		 * `created=true`, `buckets=2`.
		 *
		 * Looked up WITHOUT creating: a run the user abandons at the collision dialog must leave no
		 * row behind, and creating here would make the next run report their destination choice as
		 * « ignored », since that sentence is derived from whether the bucket was created.
		 *
		 * Two accounts of one source is the state this piece newly makes reachable, and a file alone
		 * cannot say which. Refusing here rather than taking the first is the whole point of the
		 * piece: the refusal names the screen that CAN ask, and it is a 400 the user can read.
		 */
		const source = getImportSource(result.summary.profile);
		const decision = await decideAutoAccount({
			userId: user.id,
			source,
			rows: importData.rows,
			// The answer to a previous `ask`, when the user has given one. Absent on the first run
			// and on every run of an install with one account per bank, which is the ordinary path.
			chosenId: asString(formData.get('accountId'))
		});

		if (decision.kind === 'refused') {
			// The two refusals `resolveImportBucketAccountById` tells apart, answered here with the
			// same two sentences the designation screen uses. Not-yours and not-found are one answer
			// because the asker may not be the owner; archived is its owner's own account and only
			// that sentence says what to do next.
			return fail(400, {
				error:
					decision.reason === 'archived'
						? m.import_account_error_archived()
						: m.import_account_error_required()
			});
		}

		if (decision.kind === 'ask') {
			/**
			 * THE REFUSAL CARRIES THE CONTROL THAT ANSWERS IT, which is the whole of #476.
			 *
			 * Before this the same 400 carried a sentence naming the designation screen and nothing
			 * else. That screen is not reachable from here by design (ruling A1: it does not open for
			 * a recognised file) and `/import/columns` bounces a direct visit, so a user holding two
			 * accounts at one bank could not complete the import at all. The offer is the same shape
			 * the designation screen's account row is given, drawn on this page instead.
			 *
			 * `account` and not `designation`: the columns are known, so nothing here asks about
			 * them. Sending this file to the designation screen would make the user re-answer
			 * columns they never answered, and submitting it would write a `ColumnMapping` under this
			 * file's fingerprint that shadows the built-in profile for ever, which is a durable
			 * change bought to settle a one-off question.
			 */
			return fail(400, {
				error: m.import_account_error_ambiguous_auto(),
				account: accountOfferFrom(decision.offer)
			});
		}

		if (formData.get('confirmCollision') !== '1') {
			// The bucket this run will land on, looked up WITHOUT creating it. The deduplication
			// key carries the Account.id a row lands on, so the fingerprints compared below have to
			// be built against that account. Creating it here instead would report the user's
			// destination-account choice as "ignored" on the next run, because that sentence comes
			// from whether the bucket was created.
			//
			// Null when the bucket does not exist yet, and the empty key list that follows is exact
			// rather than lenient: a bucket with no rows has no fingerprints to recognise.
			const collisionBucket = decision.kind === 'account' ? decision.bucket : decision.existing;
			const incoming = describeIncomingBatch(
				result.transactions,
				result.summary.period,
				collisionBucket && {
					accountId: collisionBucket.accountId,
					source: getImportSource(result.summary.profile),
					currency: collisionBucket.currency,
					exponent: collisionBucket.exponent,
					providerAccountId: collisionBucket.providerAccountId
				}
			);
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

		// An account that is already decided is NOT resolved again. `decideAutoAccount` returns a
		// bucket only when the file named one of this source's own accounts or the user answered
		// with one, and both are resolutions this path may not repeat: re-asking by source would
		// come back `ambiguous` and refuse the run the user has just answered.
		//
		// `created: false` by construction on that branch. A decided account is one that already
		// exists, so nothing was created for it, and the « destination choice ignored » sentence
		// downstream is derived from this flag.
		let bucket: { accountId: string; created: boolean };
		if (decision.kind === 'account') {
			bucket = { accountId: decision.bucket.accountId, created: false };
		} else {
			const resolved = await resolveImportBucketAccountBySource({
				userId: user.id,
				source
			});
			// Unreachable: the same question was asked above, before anything was written, and an
			// `ask` was returned there. Asserted rather than assumed, because « the check above
			// covers this » is a claim about two pieces of code that nothing keeps in step.
			if (resolved.kind === 'ambiguous') {
				return fail(400, { error: m.import_account_error_ambiguous_auto() });
			}
			bucket = { accountId: resolved.bucket.accountId, created: resolved.created };
		}
		const batchId = await createImportBatch({
			userId: user.id,
			accountId: bucket.accountId,
			source,
			fileName: importFile.name,
			profile: result.summary.profile,
			rowCount: result.summary.totalRows,
			invalidRows: result.summary.invalidRows,
			period: result.summary.period,
			// Only when the mapping actually read this file. `useMapping` is the same condition the
			// parser was given, so the link cannot claim a correspondance a different profile parsed.
			columnMappingId: useMapping ? (remembered?.id ?? null) : null,
			// What this import APPLIED, so a later reinterpretation has a fact rather than a guess.
			// Taken from the summary the parser returned, never recomputed here: a second derivation
			// would be a second answer, and the batch would record one the import did not use.
			dateOrder: result.summary.dateOrder ?? null
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
				autoCategorizedRows: persisted.autoCategorizedRows,
				totalDebitCents: persisted.importedDebitCents,
				totalCreditCents: persisted.importedCreditCents,
				period: result.summary.period,
				batchId,
				invalidRowDetails: buildInvalidRowDetails(importData.previewRowsByLine, result),
				hiddenInvalidRowsCount: getHiddenInvalidRowsCount(result.invalidRows.length),
				// Named through the ONE rule both screens read, so the summary and the Comptes list
				// cannot call one account two things. Read back rather than threaded out of the
				// resolution, which returns an id: the id is what the resolver knows, and the name is
				// a rendering question the resolver has no business answering.
				accountName: await readAccountDisplayName(user.id, bucket.accountId),
				// FALSE ON THIS PATH, AND THAT IS A FACT RATHER THAN A DEFAULT. This route USES a
				// remembered correspondance and never creates one: `saveColumnMapping` has exactly
				// one production call site and it is the designation route's action. Nobody
				// designated anything here, so there is nothing new to disclose.
				rememberedMapping: false,
				// Plate 7l. Populated whenever THIS parse's date order was chosen rather than proven or
				// defaulted — see `CsvImportSummary.dateOrderDisclosure`'s docstring for the one rule.
				dateOrderDisclosure: result.summary.dateOrderDisclosure ?? null
			} satisfies ImportSummaryResult
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
		// Nothing was written, so no rule ran. Stated rather than left undefined: this object and the
		// one the success path builds are read by the same panel.
		autoCategorizedRows: 0,
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
	'amount-split-across-columns',
	// Plate 7l: recognition covers mapping, not reading. The column is already correctly
	// identified; the reading offer built below answers this one directly, and sending the user to
	// redesignate columns that are not the problem is the dead end this set already exists to name.
	// Checked defensively here as well as ahead of the offer below (`!dateOrderRefusal`), because
	// this set is the guard `mixed-date-order` is deliberately absent from for the opposite reason.
	'ambiguous-date-order'
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

function getImportSource(profile: string): string {
	if (profile === 'banque-populaire') return 'banque_populaire';
	if (profile === 'revolut') return 'revolut';
	return 'csv';
}

/** A form field as a non-empty string, or null. A `File` is not an answer to a text field. */
function asString(value: FormDataEntryValue | null): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
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
		return await readImportFile(file, { maxBytes: IMPORT_FILE_MAX_BYTES });
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
