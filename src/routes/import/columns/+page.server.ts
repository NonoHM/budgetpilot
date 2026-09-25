import { fail, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { isImportRateLimited, recordImportAttempt } from '$lib/server/auth/rateLimit';
import { resolveClientAddress } from '$lib/server/net/clientAddress';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { importHeaderCells, parseCsvTransactionRows } from '$lib/server/import/csv';
import {
	ImportFileError,
	IMPORT_FILE_MAX_BYTES,
	isSupportedImportFile,
	readImportFile
} from '$lib/server/import/file';
import { mappingFromPostedIndices } from '$lib/server/import/mapping/designation';
import { readAccountColumnAnswer } from '$lib/server/import/discriminant';
import { readDateOrderAnswer } from '$lib/server/import/dateOrder';
import { fingerprintFor } from '$lib/server/import/mapping/fingerprint';
import { recordColumnMappingUse, saveColumnMapping } from '$lib/server/import/mapping/store';
import { MAPPING_ROLES } from '$lib/server/import/mapping/model';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { resolveImportOffer } from '$lib/server/import/offerPrecedence';
import { declaredCurrencyRefusal } from '$lib/server/import/declaredCurrency';
import {
	buildInvalidRowDetails,
	getHiddenInvalidRowsCount
} from '$lib/server/import/invalidRowDetails';
import {
	createImportBatch,
	ImportBucketAccountError,
	persistImportedTransactions,
	resolveImportBucketAccountById
} from '$lib/server/import/persist';
import { describeIncomingBatch, findCollidingBatch } from '$lib/server/import/collision';
import { deleteImportBatch } from '$lib/server/import/deleteBatch';
import { periodsOverlap } from '$lib/domain/periodOverlap';
import type { ReplaceOutcome } from '$lib/import/completedImport.svelte';
import type { ImportSummaryResult } from '$lib/domain/importSummary';
import { readAccountDisplayName } from '$lib/server/accounts/service';

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

		let importData;
		try {
			importData = await readImportFile(importFile, { maxBytes: IMPORT_FILE_MAX_BYTES });
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
		/**
		 * THE READING THE USER ANSWERED, when the file left the question open.
		 *
		 * Read off the form exactly as `hasHeaderRow` above is, and for the same reason: it is a
		 * per-file parse decision that the parser cannot take from any single value, because a cell
		 * reading `06/01/2026` is two valid dates with nothing in it to separate them. The answer is
		 * the screen's second step and it rides this POST.
		 *
		 * `readDateOrderAnswer` is the whole of the validation and it lives beside the type, not
		 * here: positive, against the closed set, and `undefined` for anything else, so an absent or
		 * hostile value falls back to the derivation rather than to an error. Nothing about
		 * precedence is decided here either. `decideDateOrder` is the one definition, and it consults
		 * an override only where the column leaves the question genuinely ambiguous: a file that
		 * proves its own order ignores this, and a file that proves both is refused whatever it says.
		 */
		const dateOrder = readDateOrderAnswer(formData.get('dateOrder'));

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
			maxBytes: IMPORT_FILE_MAX_BYTES,
			profile: 'mapped',
			columnMapping: resolved.mapping,
			// The user's answer, carried into the PARSE and not only into the mapping. Without it
			// the parser consumed row 0 as a header on a file that has none, losing one
			// transaction per import in silence. See `server/import/headerlessFile.spec.ts`.
			hasHeaderRow,
			// The user's answer, carried into the PARSE. Without it the parser re-derived the order
			// and settled an ambiguous column with the application default, so a user who chose
			// « Mois puis jour » read `4 mars 2026` on the row and the import stored `2026-04-03`.
			// Every date in the file wrong, the summary reporting success. See #639.
			dateOrder,
			// THIS is the caller the door trusts to have already asked, per #433's contradiction
			// pass: the designation screen (#639) defers its own close until an ambiguous column
			// is answered or the user waives it (plate 7b), so a silent day-first default here is
			// the screen's own decision, not the door guessing. `/import`'s OTHER `mapped` caller
			// (a silently reapplied remembered mapping) sets no such flag, and asks instead.
			dateOrderPromptedClientSide: true,
			sourceName: importFile.name || importData.kind,
			categorizationRules: categorizationRules.map((rule) => ({
				...rule,
				type: rule.type === 'income' || rule.type === 'expense' ? rule.type : 'any'
			})),
			// #485. No suppression flag, unlike `dateOrderPromptedClientSide` above: choosing a
			// destination account (below, `resolveImportBucketAccountById`) is a plain picker over
			// this user's accounts, never a read of the file's own account column, so this door has
			// no prior mechanism that could have already asked whether the file covers more than
			// one account. Same fix, same door, no exclusion to draw.
			accountColumnAnswer: readAccountColumnAnswer(formData.get('accountColumnAnswer'))
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
			// #485, PROVEN or just confirmed: refused outright, no offer, same reasoning as `/import`.
			const multiAccountRefusal =
				result.invalidRows.length === 1 && result.invalidRows[0].fact.code === 'multi-account-file'
					? result.invalidRows[0].fact
					: null;
			// #485, UNPROVEN: the one offer this branch gains.
			const accountColumnRefusal =
				result.invalidRows.length === 1 &&
				result.invalidRows[0].fact.code === 'ambiguous-account-column'
					? result.invalidRows[0].fact
					: null;
			// THE ONE ORDER, same function `/import` reads: no `split`, `account` or `dateOrder` on this
			// door (see `offerPrecedence.ts`'s own docstring for why), so those are simply never passed.
			// `produced: false` because this branch is the empty parse.
			const offer = resolveImportOffer({
				produced: false,
				header: headerRefusal?.fact ?? null,
				multiAccount: multiAccountRefusal,
				accountColumn: accountColumnRefusal ? { state: 'open', fact: accountColumnRefusal } : null
			});
			/**
			 * #485's `accountColumn` rung REFUSES rather than asks on this door, and DOES NOT carry
			 * an offer: `/import/columns` has no interactive control for it (#670), and shipping the
			 * "confirm before importing" sentence with no way to confirm is the exact dead end
			 * `DESIGNATION_CANNOT_REPAIR` names in `/import`'s own action, applied to the door the
			 * user is already ON rather than one they would be sent to. `not-account`/`is-account`
			 * are never posted from this door for the same reason: nothing here can answer.
			 *
			 * The message NAMES THE RECOURSE instead: this door cannot silently drop the column
			 * either, because an unproven signal is still real evidence, and #485's whole point is
			 * that a file that might name several accounts must not import as one silently. The only
			 * two honest outcomes left are refuse-with-recourse (this) or ask (which this door
			 * cannot do), never a third state that guesses.
			 */
			const accountColumnHeader =
				accountColumnRefusal && headers[accountColumnRefusal.column]
					? headers[accountColumnRefusal.column]
					: undefined;
			return fail(400, {
				error:
					offer.rung === 'header' || offer.rung === 'multiAccount'
						? refusalLabel(offer.fact)
						: offer.rung === 'accountColumn'
							? accountColumnHeader
								? m.import_error_account_column_unanswerable({ header: accountColumnHeader })
								: m.import_error_account_column_unanswerable_no_header({
										count: offer.fact.column + 1
									})
							: m.import_error_no_valid_transactions(),
				keepDesignation: true
			});
		}

		/**
		 * The batch this correction replaces, resolved before it can decide anything.
		 *
		 * The id crossed a navigation in the browser's own memory (`pendingDesignation`), so it
		 * arrives here as an input and nothing more: it is re-resolved against this user's own
		 * batches, exactly like the correspondance id on `/import`. An id that names a delete is
		 * never carried on trust.
		 */
		const replaceParam = asString(formData.get('replaceBatchId'));
		const replacing =
			replaceParam && replaceParam.length > 0
				? await prisma.importBatch.findFirst({
						where: { id: replaceParam, userId: user.id },
						// The PERIOD comes back with the id, because nothing else on this request can tell
						// whether the file handed back is the statement being corrected. See the withhold
						// block below.
						select: {
							id: true,
							createdAt: true,
							periodStart: true,
							periodEnd: true
						}
					})
				: null;

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
		/**
		 * THE ACCOUNT THIS STATEMENT BELONGS TO, AND THE FIRST CLIENT-SUPPLIED OBJECT REFERENCE THIS
		 * ROUTE HAS EVER ACCEPTED.
		 *
		 * `AGENTS.md` says never take a `userId` from the client. This is the same class one object
		 * over: the id decides which account a statement is filed into, it arrives in a POST body,
		 * and a reference a client posts is a claim rather than a fact. `resolveImportBucketAccountById`
		 * puts `userId` in the SAME where clause, so not-yours and not-found are one answer and this
		 * endpoint cannot be used to enumerate other users' account ids.
		 *
		 * ## Every one of the five refusals is a 400 the user can read, and never a 500
		 *
		 * Malformed, missing, well formed but nonexistent, and belonging to somebody else all reach
		 * `not-found` and share one sentence. An ARCHIVED account of the user's own gets its own,
		 * because they own it and the useful thing to say is what to do next. The text says what to
		 * DO rather than what went wrong: « Choisissez le compte de ce relevé » rather than
		 * « accountId invalide », which names a field the user never saw.
		 *
		 * `keepDesignation` because a refusal here must not cost the work: the user is being asked
		 * which account, not asked to designate the columns again.
		 *
		 * Resolved BEFORE the collision check, so both it and the write below reason about one
		 * account rather than two, and before any write, so a refusal leaves nothing behind.
		 */
		let bucket;
		try {
			bucket = await resolveImportBucketAccountById({
				userId: user.id,
				accountId: asString(formData.get('accountId')) ?? ''
			});
		} catch (error) {
			return fail(400, {
				error:
					error instanceof ImportBucketAccountError && error.reason === 'archived'
						? m.import_account_error_archived()
						: m.import_account_error_required(),
				keepDesignation: true
			});
		}

		/**
		 * #600: the currency the file DECLARES, against the account the user just chose. Same call as
		 * `/import`'s, right after the destination resolves and before the collision question, the
		 * memorised correspondance and every write. `keepDesignation` because the repair is choosing
		 * another account on this screen, not designating the columns again.
		 */
		const currencyRefusal = declaredCurrencyRefusal(
			result.summary.declaredCurrencies ?? [],
			bucket
		);
		if (currencyRefusal) {
			// With the currency the file declared, so the screen's account panel can say which accounts
			// are in it, exactly as `/import`'s does (#600, second contradiction pass F3).
			return fail(400, {
				error: refusalLabel(currencyRefusal),
				keepDesignation: true,
				declaredCurrency: currencyRefusal.declared
			});
		}

		if (formData.get('confirmCollision') !== '1') {
			// The account the user CHOSE, which is now the same object the write path below uses.
			//
			// It used to be a lookup by name that could come back null, and the null case existed
			// because the bucket might not have been created yet. There is no such case now: an
			// account the user picked from the panel exists by construction, and the fingerprints
			// compared below are built against the very row the rows will land in. Resolving it
			// once, above, is also what stops the collision check and the write from ever reasoning
			// about two different accounts.
			//
			// `'csv'` is the SOURCE, and it stays the literal it was: it describes how the file was
			// READ (designated by hand), not which account it lands in. Those two were the same
			// question only while the destination was derived from the profile.
			const incoming = describeIncomingBatch(result.transactions, result.summary.period, {
				accountId: bucket.accountId,
				source: 'csv',
				currency: bucket.currency,
				exponent: bucket.exponent,
				providerAccountId: bucket.providerAccountId
			});
			// The batch being replaced is not a collision with itself: a correction re-reads the same
			// statement, so it matches all three terms by construction. Scoped to that one id rather
			// than to the correction path, because a genuine earlier import of the same statement
			// still doubles the money and still has to raise the dialog.
			const collision = await findCollidingBatch(
				user.id,
				incoming,
				replacing ? { excludeBatchId: replacing.id } : {}
			);
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

		const batchId = await createImportBatch({
			userId: user.id,
			accountId: bucket.accountId,
			source: 'csv',
			fileName: importFile.name,
			profile: result.summary.profile,
			rowCount: result.summary.totalRows,
			invalidRows: result.summary.invalidRows,
			period: result.summary.period,
			columnMappingId,
			// As on the upload path: the order the parse applied, read off its own summary.
			dateOrder: result.summary.dateOrder ?? null
		});
		const persisted = await persistImportedTransactions({
			userId: user.id,
			accountId: bucket.accountId,
			importBatchId: batchId,
			source: 'csv',
			transactions: result.transactions,
			parseDuplicateRows: result.summary.duplicateRows
		});

		/**
		 * The replace, and the one guard between it and a silent loss of transactions.
		 *
		 * ## AFTER the write, never before
		 *
		 * The full reasoning lives in `deleteBatch.ts` and it is not a preference. This route cannot
		 * put the write and the delete in one transaction, because `persistImportedTransactions`
		 * catches a unique violation and carries on, which PostgreSQL does not allow inside one. The
		 * ordering is therefore the only control there is: write-then-delete degrades to a doubled
		 * state the user already knows how to repair, delete-then-write degrades to data loss with
		 * the file held only in the browser.
		 *
		 * ## AND THE DELETE IS WITHHELD WHEN THE CORRECTION LANDED FEWER ROWS THAN IT WOULD DESTROY
		 *
		 * The control the user ticked consented to replacing this batch, not to replacing it with
		 * less. Moving the amount role onto a column with blanks produces exactly that: the blank
		 * rows are refused, the new batch is smaller, and deleting the old one is a net loss of
		 * transactions inside a flow called correction.
		 *
		 * Withheld rather than refused, because a smaller corrected batch is often CORRECT: rows
		 * that only imported because a reference column happened to parse as a number are not data
		 * worth keeping, and refusing outright would send the user back through the whole old
		 * journey for a repair that worked. So the deliberate delete waits on `/imports`, behind the
		 * confirmation that names the timestamp and the splits-and-tags cost.
		 *
		 * ## TWO DETAILS DECIDE WHETHER THIS CHECK IS ANY GOOD
		 *
		 * The count is LIVE and not the batch's `importedRows` column. That column is a fact about
		 * the past import; this needs the verdict on the present, which is what the delete will
		 * actually destroy. The two diverge as soon as the user has deleted a row by hand, and
		 * getting it backwards lets the guard pass while real rows die.
		 *
		 * And it compares COUNTS, NEVER TOTALS. A correction that fixes the amount column changes
		 * the totals by design, so a totals check fires on every correct repair, and a check that
		 * fires on the good case is discounted within a week and then removed.
		 */
		// ONE field with three states rather than two booleans. "Nothing was replaced" and "the
		// replacement was withheld" are different things to say, and the second has to RETRACT a
		// promise: two screens announce the replacement before any row is counted, so a run that
		// then withholds owes the user the NAME of the import it did not delete. `replacedAt` is
		// that name, and it doubles as the identifier they need on `/imports`.
		let replaced: ReplaceOutcome = { kind: 'none' };
		if (replacing) {
			const replacedRows = await prisma.transaction.count({
				where: { userId: user.id, importBatchId: replacing.id }
			});
			const replacedAt = replacing.createdAt.toISOString();
			const replacedPeriod = {
				from: replacing.periodStart?.toISOString() ?? null,
				to: replacing.periodEnd?.toISOString() ?? null
			};
			if (!periodsOverlap(replacedPeriod, result.summary.period)) {
				// THE WRONG STATEMENT, handed back. Withheld for the same reason and by the same
				// mechanism as the fewer-rows case, and it is the more dangerous of the two: that one
				// costs rows the user may not have wanted, this one costs a whole statement they never
				// touched.
				//
				// `correctionMatchesFile` on `/import` cannot see it. It compares the header SHAPE, and
				// two statements from one bank have identical headers by construction, so the check that
				// exists passes on precisely the file that must not be accepted. Walked in a browser
				// before this guard existed: correcting a July import with June's file deleted July and
				// left two copies of June, with the summary reporting the deletion as a success.
				//
				// A WARNING RATHER THAN A REFUSAL, and the asymmetry is the argument. Refusing would send
				// a user whose file is merely oddly dated back through the thirteen-step tail this wave
				// exists to remove; withholding leaves both imports and a named route to finish by hand.
				// Two statements of the same month always overlap however their dates are read, so this
				// fires on a wrong file and essentially nothing else.
				replaced = { kind: 'withheldOtherPeriod', replacedAt, replacedPeriod };
			} else if (persisted.importedRows < replacedRows) {
				replaced = {
					kind: 'withheld',
					replacedAt,
					replacedRows,
					importedRows: persisted.importedRows
				};
			} else if (await deleteImportBatch(user.id, replacing.id)) {
				replaced = { kind: 'deleted', replacedAt };
			}
		}

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
				// The rejected rows themselves, not only their count. This route used to return the
				// count alone, so a designated import could reject rows and name none of them, on the
				// one run where the user had just chosen the columns and could still tell a wrong
				// choice from a bad file. Same shape as `/import` so one panel draws both (#338).
				invalidRowDetails: buildInvalidRowDetails(importData.previewRowsByLine, result),
				hiddenInvalidRowsCount: getHiddenInvalidRowsCount(result.invalidRows.length),
				// Named through the ONE rule both screens read, so the summary and the Comptes list
				// cannot call one account two things. Read back rather than threaded out of the
				// resolution, which returns an id: the id is what the resolver knows, and the name is
				// a rendering question the resolver has no business answering.
				accountName: await readAccountDisplayName(user.id, bucket.accountId),
				// Non-null exactly when this run stored a correspondance: a headerless file is never
				// memorised, and an opt-out skips the block entirely. The disclosure sentence on the
				// summary is drawn from this and from nothing else, so a user who opted out is not
				// told their columns will be reused.
				rememberedMapping: columnMappingId !== null,
				dateOrderDisclosure: result.summary.dateOrderDisclosure ?? null
			} satisfies ImportSummaryResult,
			capReached,
			replaced
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
