import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { applyCategoryRules } from '$lib/server/categorization/rules';
import { prisma } from '$lib/server/db';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { anonymizeDetailText } from '$lib/server/transactions/anonymize';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { institutionForSource } from '$lib/server/import/accountBackfill';
import { GENERIC_BUCKET_STORED_NAME, MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';
import { computeDedupeKeyHash, dedupeKeyUpdate } from '$lib/server/import/dedupeKey';
import { assignDedupeKeysForBatch } from '$lib/server/import/dedupeRecompute';
import { isUniqueConstraintViolation, withConcurrentWriteRetry } from '$lib/server/database/upsert';
import { replaceSplits } from '$lib/server/transactions/splits';
import type { ImportedTransaction } from './types';

/**
 * Shared import persistence — the single write path for every transaction source that
 * converges on ImportedTransaction[] (CSV profiles today, bank connectors at bank-sync
 * step 4). Extracted verbatim from routes/import/+page.server.ts: dedup semantics
 * (metadata.deduplicationKey lookup + P2002 fallback), category upsert, metadataJson
 * shape and the "link applied only on bucket creation" rule are all preserved.
 *
 * Every function here takes an explicit userId coming from the caller's
 * `requireUser(locals.user)` — never from client input.
 */

const METADATA_CELL_ANONYMIZE_LIMIT = 18;
const METADATA_CSV_FIELD_ALLOWLIST = [
	'Libelle simplifie',
	'Libelle operation',
	'Type operation',
	'Categorie',
	'Sous categorie',
	'Informations complementaires',
	'Date de comptabilisation',
	'Date operation',
	'Date de valeur',
	'Pointage operation'
];

/** PII-masking applied to any raw CSV cell before it is persisted or previewed. */
export function anonymizeImportCell(value: string): string {
	return anonymizeDetailText(value, METADATA_CELL_ANONYMIZE_LIMIT);
}

export interface ImportBucketInput {
	userId: string;
	name: string;
	source: string;
	/**
	 * What this bucket's amounts are denominated in, as a PAIR.
	 *
	 * One field and not two, so a caller cannot pass a currency without an exponent. That is the
	 * whole rule the columns exist for: a bucket created under a non-euro currency with no exponent
	 * beside it is ambiguous forever, and an optional `currency?: string` beside an optional
	 * `exponent?: number` is exactly the shape that lets somebody supply one. Omitted entirely means
	 * the application default (`DEFAULT_DENOMINATION`).
	 */
	denomination?: { currency: string; exponent: number };
	/**
	 * Applied only when the bucket is first created — an existing bucket's link is never silently
	 * changed by a later import.
	 *
	 * ONE CALLER SETS THIS, and naming it is the point: `banking/sync/service.ts`, where the
	 * provider hands over an account that IS a net worth line. The CSV import path used to set it
	 * too, from a control on the upload form, and that control answered « which net worth line does
	 * this bucket feed » on a screen asking « where does this file go ». It was removed with the
	 * rest of that question; the link is now set on the Comptes screen, where the subject is an
	 * account rather than a file.
	 */
	netWorthAccountId?: string | null;
	/**
	 * The proper noun for the bank, when the source names one. Create-only, like every field
	 * around it.
	 *
	 * Set at creation rather than left to the boot backfill, and the reason is convergence rather
	 * than tidiness: `accountsPendingWhere()` is `{ source in NAMEABLE_SOURCES, institution: null }`,
	 * so a bucket born with a null institution keeps that predicate true and makes the once-only
	 * boot pass run again on every start, for ever, rewriting the same row each time.
	 */
	institution?: string | null;
	/** Same create-only semantics; set by the bank-sync service (step 4), never by CSV imports. */
	bankConnectionId?: string | null;
	/**
	 * Provider-side account uid, bank-sync only. When set, the bucket is resolved by
	 * (userId, source, providerAccountId) FIRST — the stable mapping — and the name only
	 * matters at creation time (disambiguated if another bucket already holds it, so two
	 * provider accounts can never silently merge into one bucket).
	 */
	providerAccountId?: string | null;
	/**
	 * Provider-side cash account type (bank-sync only), same create-only semantics as
	 * providerAccountId — captured once at bucket creation, never overwritten by a later
	 * sync. Non-sensitive metadata; feeds a NetWorthAccount type suggestion, never
	 * authoritative (see domain/netWorth.ts's suggestNetWorthAccountType).
	 */
	providerCashAccountType?: string | null;
}

export interface ImportBucketResult {
	accountId: string;
	/** false when the bucket already existed, meaning every create-only field above was ignored. */
	created: boolean;
}

/**
 * Longest bucket name written to `Account.name`, matching the cap the net worth and savings
 * goal services already apply to their own names.
 *
 * A bucket name is not always the app's to choose: on the bank-sync path it is whatever the
 * bank called the account (`toConnectorAccount`, from the provider's `name` or `product`), and
 * the connector puts no bound on it. `Account.name` is the one indexed column an outside party
 * can therefore overflow, and MySQL rejects the write rather than truncating it, so an
 * uncapped name is a sync that fails on one provider only. Capping here rather than in
 * `sanitizeImportedText()` keeps the bound on the column that has one: labels and notes are
 * `@db.Text` and want no cap.
 *
 * Leaves room for the ` · xxxxxx` disambiguation suffix appended below (9 characters), and the
 * column itself is `varchar(255)` on MySQL, so a name from before this cap still restores.
 */
const MAX_BUCKET_NAME_LENGTH = MAX_ACCOUNT_NAME_LENGTH;

function capBucketName(name: string): string {
	if (name.length <= MAX_BUCKET_NAME_LENGTH) return name;

	// Cut on characters, not UTF-16 code units: slicing mid-surrogate leaves a lone half that is
	// not valid UTF-8, which MySQL's utf8mb4 rejects. `Array.from` iterates code points, so an
	// emoji or any astral character is kept whole or dropped whole.
	const capped = Array.from(name).slice(0, MAX_BUCKET_NAME_LENGTH).join('').trim();

	// A name that is only whitespace past the cut would trim to nothing, and an empty bucket
	// name is worse than a long one: it collides with every other empty-named bucket under
	// (userId, name, source). Keep the untrimmed cut in that case.
	return capped || Array.from(name).slice(0, MAX_BUCKET_NAME_LENGTH).join('');
}

/**
 * What a caller learns about the bucket a run will land on, when it exists.
 *
 * Carries the denomination because the deduplication key does: an amount is identified by its
 * magnitude AND what that magnitude is denominated in, so a reader of the key needs both.
 * `bankConnectionId` is here for the resolver's relink rule and is ignored by everyone else.
 */
export interface ImportBucketAccount {
	accountId: string;
	currency: string;
	exponent: number;
	providerAccountId: string | null;
	bankConnectionId: string | null;
}

/**
 * One shape for both lookups, so a caller cannot get a bucket that answers fewer questions
 * depending on which query happened to find it.
 */
const BUCKET_SELECT = {
	id: true,
	currency: true,
	exponent: true,
	providerAccountId: true,
	bankConnectionId: true
} as const;

type BucketRow = {
	id: string;
	currency: string;
	exponent: number;
	providerAccountId: string | null;
	bankConnectionId: string | null;
};

function toBucketAccount(row: BucketRow | null): ImportBucketAccount | null {
	return row === null
		? null
		: {
				accountId: row.id,
				currency: row.currency,
				exponent: row.exponent,
				providerAccountId: row.providerAccountId,
				bankConnectionId: row.bankConnectionId
			};
}

/** The stable mapping: a provider account belongs to exactly one bucket, whatever it is called. */
function findBucketByProviderAccount(
	userId: string,
	source: string,
	providerAccountId: string
): Promise<BucketRow | null> {
	return prisma.account.findFirst({
		where: { userId, source, providerAccountId },
		select: BUCKET_SELECT
	});
}

/**
 * Folded match, like categories: a bucket named "Courses" and an import announcing "courses" are
 * the same bucket, and creating a second one would split the history.
 *
 * Ordered, unlike the category lookup next door, because more than one row can match here.
 * `Account` is the one name-keyed table with no unique constraint on its key: the name-key backfill
 * deliberately refuses to merge two buckets carrying conflicting bank or net-worth links, and
 * leaves both in place. An unordered `findFirst` would then be free to answer with a different
 * bucket on each call, stable on SQLite and arbitrary on PostgreSQL, and the same import would
 * scatter its rows. Oldest first, matching the survivor rule the merge plan uses, so both agree on
 * which bucket is the real one.
 *
 * Takes the CAPPED name. A bucket created from a long provider name was stored capped, so its
 * stored `nameKey` is the capped one, and folding the uncapped name would miss the bucket that
 * exists.
 */
function findBucketByFoldedName(
	userId: string,
	cappedName: string,
	source: string
): Promise<BucketRow | null> {
	return prisma.account.findFirst({
		where: { userId, nameKey: computeNameKey(cappedName), source },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: BUCKET_SELECT
	});
}

/**
 * The bucket a run would land on, WITHOUT creating one. Null when it does not exist yet.
 *
 * Exists because the deduplication key carries the `Account.id` a row lands on, and
 * `findCollidingBatch` compares keys against the database before anything is written. So the
 * collision check needs the bucket, and it must not bring one into being: `resolveImportBucketAccount`
 * reports whether it CREATED the bucket, the import summary turns that into "your destination
 * account was applied" or "ignored", and creating the bucket during a check would make the next
 * run report "ignored" about a run the user had cancelled.
 *
 * **Null is exact rather than lenient.** A bucket that does not exist holds no transactions, so no
 * stored key can carry its id, so a fingerprint comparison against it has nothing to find. The
 * caller passing an empty key list on this answer computes the same verdict as one passing keys
 * that match nothing.
 *
 * Composed from the same two lookups the resolver uses, in the same order, which is what keeps the
 * read path and the write path agreeing about which bucket a run lands on. Note the provider case:
 * when a provider account has no bucket yet the answer is null EVEN IF the name is taken, because
 * the resolver disambiguates that name into a new bucket rather than reusing the one holding it.
 */
export async function findImportBucketAccount(input: {
	userId: string;
	name: string;
	source: string;
	providerAccountId?: string | null;
}): Promise<ImportBucketAccount | null> {
	if (input.providerAccountId) {
		return toBucketAccount(
			await findBucketByProviderAccount(input.userId, input.source, input.providerAccountId)
		);
	}
	return toBucketAccount(
		await findBucketByFoldedName(input.userId, capBucketName(input.name), input.source)
	);
}

/**
 * Resolves (or creates) the technical Account bucket a batch of imported transactions
 * lands on, keyed by the (userId, name, source) unique constraint.
 */
export async function resolveImportBucketAccount(
	input: ImportBucketInput
): Promise<ImportBucketResult> {
	if (input.providerAccountId) {
		const byProviderAccount = await findBucketByProviderAccount(
			input.userId,
			input.source,
			input.providerAccountId
		);
		if (byProviderAccount) {
			// Exception to the create-only rule, and the ONLY allowed relink: a bucket
			// orphaned by a connection deletion (onDelete: SetNull) is re-attached when the
			// same provider account comes back through a new/renewed connection. A non-null
			// link is still never overwritten.
			if (input.bankConnectionId && byProviderAccount.bankConnectionId === null) {
				await prisma.account.update({
					where: { id: byProviderAccount.id },
					data: { bankConnectionId: input.bankConnectionId }
				});
			}
			return { accountId: byProviderAccount.id, created: false };
		}
	}

	let name = capBucketName(input.name);
	const existing = await findBucketByFoldedName(input.userId, name, input.source);
	if (existing) {
		if (!input.providerAccountId) return { accountId: existing.id, created: false };
		// The name is held by a bucket mapped to a DIFFERENT provider account (or none):
		// disambiguate with an opaque suffix (never the raw uid) instead of merging.
		name = `${name} · ${hashFingerprint(input.providerAccountId).slice(0, 6)}`;
	}

	// Upsert (not create) so a concurrent first import of the same bucket cannot throw, wrapped
	// because the empty update below costs it Prisma's atomic form (server/database/upsert.ts).
	const account = await withConcurrentWriteRetry(() =>
		prisma.account.upsert({
			where: { userId_name_source: { userId: input.userId, name, source: input.source } },
			update: {},
			create: {
				...(input.denomination ?? DEFAULT_DENOMINATION),
				userId: input.userId,
				name,
				nameKey: computeNameKey(name),
				source: input.source,
				netWorthAccountId: input.netWorthAccountId ?? null,
				institution: input.institution ?? null,
				bankConnectionId: input.bankConnectionId ?? null,
				providerAccountId: input.providerAccountId ?? null,
				providerCashAccountType: input.providerCashAccountType ?? null
			}
		})
	);
	return { accountId: account.id, created: true };
}

/**
 * The bucket for a statement the user has DESIGNATED, resolved by the id they chose.
 *
 * ## Why this exists beside `resolveImportBucketAccount` rather than replacing it
 *
 * The sibling above resolves by NAME, and that is the measured hazard this piece removes: rename a
 * bucket while name resolution is live and the next import reports `created=true`, a second bucket
 * appears, and the same statement imports again. It stays for the bank-sync path, which resolves by
 * `(userId, source, providerAccountId)` and legitimately CREATES a bucket the user never named.
 * The CSV routes stop calling it.
 *
 * ## `accountId` ARRIVES FROM THE CLIENT, SO IT IS A CLAIM RATHER THAN A FACT
 *
 * `userId` is in the SAME where clause, never as a check afterwards, because a check afterwards is
 * a second statement someone can delete without the first one failing. A reference that does not
 * resolve is refused as NOT FOUND, and not-yours and not-found are deliberately ONE answer: two
 * different messages would turn this into an oracle for enumerating other users' account ids.
 *
 * The refusal never names the id. An error message travels, through a log line, a screenshot, a
 * ticket and a clipboard. ASVS 5.0.0 `v5.0.0-8.2.2` is the row; the scoped where clause is the
 * control, and `resolveByChosenId.db-smoke.ts` is the attack. That file is a db-smoke and not a
 * unit spec on purpose: a fake decides what `findFirst` returns, so « the query was scoped » and
 * « the fake returned nothing » are the same green.
 */
export class ImportBucketAccountError extends Error {
	/**
	 * WHY THIS IS A CLASS AND NOT A MESSAGE THE CALLER MATCHES ON.
	 *
	 * The route has to tell two refusals apart to say what to DO about each, and matching on error
	 * text would put the caller and the thrower on one source: the two sides of that comparison
	 * would be the same string, so the check would pass by construction and stop meaning anything
	 * the day someone rewords the message. `reason` is the thing the route branches on; the message
	 * is for humans reading a log, and neither is derived from the other.
	 */
	readonly reason: 'not-found' | 'archived';

	constructor(reason: 'not-found' | 'archived') {
		super(
			reason === 'archived'
				? 'Import bucket account is archived'
				: 'Import bucket account not found'
		);
		this.reason = reason;
		this.name = 'ImportBucketAccountError';
	}
}

export async function resolveImportBucketAccountById(input: {
	userId: string;
	accountId: string;
}): Promise<ImportBucketAccount> {
	const account = await prisma.account.findFirst({
		where: { id: input.accountId, userId: input.userId },
		select: { ...BUCKET_SELECT, archivedAt: true }
	});
	const bucket = toBucketAccount(account);
	if (bucket === null) {
		throw new ImportBucketAccountError('not-found');
	}
	/**
	 * An ARCHIVED account is refused, and refused DIFFERENTLY, which is deliberate rather than an
	 * inconsistency with the paragraph above.
	 *
	 * Not-yours and not-found are one answer because the person asking may not be the owner. This
	 * one they own: the plate keeps an archived account off the panel, so reaching here at all takes
	 * a hand-made request or an account archived in another tab mid-designation. Saying « archived »
	 * to its owner discloses nothing they do not already have, and it is the only version of the
	 * sentence that tells them what to do next. Silence here would send them back to a panel that
	 * does not contain the account they just chose.
	 */
	if (account?.archivedAt) {
		throw new ImportBucketAccountError('archived');
	}
	return bucket;
}

export type ImportBucketBySourceResolution =
	{ kind: 'resolved'; bucket: ImportBucketAccount; created: boolean } | { kind: 'ambiguous' };

/**
 * The destination for the AUTO path, which has no account row to ask with.
 *
 * `/import` imports a recognised file without ever showing the designation screen, so unlike the
 * designated path there is no `accountId` in the request. It used to resolve
 * `(name: 'Compte import CSV', source)`, and that stopped working the moment the boot backfill
 * started renaming buckets: MEASURED on this branch before the fix, the lookup came back empty,
 * reported `created=true`, and left `buckets=2` for one user's Banque Populaire history. That is
 * the silent history duplication this whole piece exists to remove, caused by the fix for it, and
 * it is the second of Task 6's three reasons for being one commit.
 *
 * ## The source is the key now, and where it stops being enough it REFUSES
 *
 * One non-archived account of that source is every install that exists today, so this is
 * behaviour-preserving rather than new. Two is the state this piece newly makes reachable, and
 * there is no honest way to choose between them from the file alone: taking the first is how a
 * statement lands in the wrong account silently, which is the exact defect being repaired. So it
 * hands the question back, and the caller sends the user to the screen that can ask.
 *
 * `userId` is in the SAME where clause as `source`. A source is not a secret and every customer of
 * one bank shares it, so a query on `source` alone would resolve onto somebody else's account.
 *
 * An archived account is not a candidate. It keeps the imports it already has; what it must not do
 * is silently receive new ones on the one path that shows the user nothing.
 */
export type ImportBucketSourceLookup =
	{ kind: 'one'; bucket: ImportBucketAccount } | { kind: 'none' } | { kind: 'ambiguous' };

/**
 * The same question WITHOUT creating anything, because one caller must not create.
 *
 * The collision check on `/import` builds its fingerprints against the destination account and runs
 * BEFORE the user has confirmed anything. Creating the bucket there would make the next run report
 * the user's destination choice as « ignored », because that sentence is derived from whether the
 * bucket was created. A run the user abandons must leave no row behind either.
 *
 * Split out rather than given a `create: false` flag: a boolean parameter that changes whether a
 * function writes is the shape where a caller reads the call site and cannot tell.
 */
export async function findImportBucketAccountBySource(input: {
	userId: string;
	source: string;
}): Promise<ImportBucketSourceLookup> {
	const candidates = await prisma.account.findMany({
		where: { userId: input.userId, source: input.source, archivedAt: null },
		select: BUCKET_SELECT,
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
	});
	if (candidates.length > 1) return { kind: 'ambiguous' };
	const existing = toBucketAccount(candidates[0] ?? null);
	return existing === null ? { kind: 'none' } : { kind: 'one', bucket: existing };
}

export async function resolveImportBucketAccountBySource(input: {
	userId: string;
	source: string;
}): Promise<ImportBucketBySourceResolution> {
	const found = await findImportBucketAccountBySource(input);
	if (found.kind === 'ambiguous') return { kind: 'ambiguous' };
	if (found.kind === 'one') return { kind: 'resolved', bucket: found.bucket, created: false };

	const institution = institutionForSource(input.source);
	// The sibling above is reused for the CREATE alone, so the upsert, the concurrent-write retry
	// and the name cap stay in one place. Resolving by name is safe HERE in a way it was not safe
	// on the routes: the name is derived from the source on the line above, rather than being a
	// constant that a later rename can invalidate.
	const created = await resolveImportBucketAccount({
		userId: input.userId,
		name: institution ?? GENERIC_BUCKET_STORED_NAME,
		source: input.source,
		institution
	});
	/**
	 * `created: false` here has exactly one cause, and it is worth spelling out because it reads
	 * like a missing case.
	 *
	 * The lookup above found no NON-ARCHIVED account of this source, so if the upsert nonetheless
	 * found an existing row holding `(userId, name, source)`, that row is archived by elimination.
	 * `@@unique` means a second one cannot be made beside it, and filing into it is precisely the
	 * behaviour archiving exists to prevent, so the question goes back to the user.
	 *
	 * Derived rather than re-queried: reading the row again to ask whether it is archived would be
	 * a second statement someone can delete without the first one failing, and the answer is
	 * already determined by the two facts above.
	 */
	if (!created.created) return { kind: 'ambiguous' };
	return {
		kind: 'resolved',
		bucket: {
			accountId: created.accountId,
			currency: DEFAULT_DENOMINATION.currency,
			exponent: DEFAULT_DENOMINATION.exponent,
			providerAccountId: null,
			bankConnectionId: null
		},
		created: true
	};
}

export interface CreateImportBatchInput {
	userId: string;
	source: string;
	fileName: string;
	profile: string;
	rowCount: number;
	invalidRows: number;
	/**
	 * The account this statement is filed into. REQUIRED here while the column is nullable, and the
	 * asymmetry is the point.
	 *
	 * The column has to accept null, because a batch imported before this shipped genuinely has no
	 * account until the boot backfill reads its own transactions. This input does not, because the
	 * application always knows which bucket it just resolved. So history may be null and nothing
	 * new ever is, which is what makes the backfill a one-time pass rather than a permanent
	 * cleanup running behind a writer that keeps producing more work for it.
	 */
	accountId: string;
	/** ISO dates (YYYY-MM-DD) or null when the batch has no valid dated row. */
	period: { from: string | null; to: string | null };
	/**
	 * The correspondance this batch was read through, when there was one.
	 *
	 * What makes a memorised mapping reachable from `/imports` afterwards. Both mapped paths pass
	 * it: the run that designates and every later run that is recognised. Null everywhere else,
	 * which is the five auto-detected profiles and every batch imported before the mapping path.
	 */
	columnMappingId?: string | null;
}

/** Creates the ImportBatch row a persistence run reports into; returns its id. */
export async function createImportBatch(input: CreateImportBatchInput): Promise<string> {
	const batch = await prisma.importBatch.create({
		data: {
			userId: input.userId,
			accountId: input.accountId,
			source: input.source,
			fileName: input.fileName,
			profile: input.profile,
			rowCount: input.rowCount,
			invalidRows: input.invalidRows,
			columnMappingId: input.columnMappingId ?? null,
			periodStart: input.period.from ? new Date(`${input.period.from}T00:00:00.000Z`) : null,
			periodEnd: input.period.to ? new Date(`${input.period.to}T00:00:00.000Z`) : null
		}
	});
	return batch.id;
}

export interface PersistImportedTransactionsInput {
	userId: string;
	accountId: string;
	importBatchId: string;
	/** Transaction.source value (e.g. 'csv', 'revolut', a bank provider id). */
	source: string;
	transactions: ImportedTransaction[];
	/** Duplicates already detected upstream (e.g. at CSV parse time) — folded into the batch's final duplicateRows. */
	parseDuplicateRows?: number;
}

export interface PersistImportedTransactionsResult {
	importedRows: number;
	/** parseDuplicateRows + rows skipped here because their dedupeKey already exists. */
	duplicateRows: number;
	importedDebitCents: number;
	importedCreditCents: number;
	importedTransactionIds: string[];
	/**
	 * How many of the rows just written were immediately rewritten by the user's own categorization
	 * rules. Reported to the user on the import summary: the rules are wanted, but a category the
	 * application chose is a statement about their money that the file did not make.
	 */
	autoCategorizedRows: number;
}

/**
 * Persists a parsed batch: per-transaction dedup + insert, then category rules over the
 * newly inserted rows, then the batch's imported/duplicate counters. Rows whose
 * deduplicationKey already exists for this user are silently skipped (counted as
 * duplicates), matching the historical CSV behavior.
 */
export async function persistImportedTransactions(
	input: PersistImportedTransactionsInput
): Promise<PersistImportedTransactionsResult> {
	let importedRows = 0;
	let duplicateRows = input.parseDuplicateRows ?? 0;
	let importedDebitCents = 0;
	let importedCreditCents = 0;
	const importedTransactionIds: string[] = [];

	// Read ONCE, before the loop, and passed down: every row of an import lands in one bucket, and
	// a transaction is denominated by the bucket it lands in. `DEFAULT_DENOMINATION` here would
	// make every row of a non-euro bucket positively assert something false, which is exactly what
	// the migration goes out of its way to avoid for the rows that already exist.
	//
	// `providerAccountId` joins the read because the deduplication key needs it: a bank row keys on
	// the provider's per-account entry reference, scoped by that account.
	const bucket = await prisma.account.findUniqueOrThrow({
		where: { id: input.accountId },
		select: { currency: true, exponent: true, providerAccountId: true }
	});

	// Every key for this batch, computed HERE rather than at parse time, and the reasons are in
	// `dedupeRecompute.ts`. The short version: the CSV path cannot know its `accountId` at parse
	// time because the bucket's source comes from the detected profile, and the ordinal has to be
	// handed out over the rows being WRITTEN or a row refused after its fingerprint was built
	// leaves a gap that a later recompute closes by re-keying a stored row.
	const dedupeKeys = assignDedupeKeysForBatch(input.transactions, {
		accountId: input.accountId,
		source: input.source,
		currency: bucket.currency,
		exponent: bucket.exponent,
		providerAccountId: bucket.providerAccountId
	});

	// Narrowed EXPLICITLY, and not merely for tidiness. `persistTransaction` spreads this object
	// into `prisma.transaction.create`, so every field on it becomes a column name. Passing the
	// bucket row itself worked while the read was `{ currency, exponent }` and broke the moment
	// `providerAccountId` joined it for the key: Prisma rejects an unknown argument at run time,
	// the whole import dies, and neither `npm run check` nor a mocked suite can see it, because a
	// mock has no column list to disagree with. An e2e import found it.
	const denomination = { currency: bucket.currency, exponent: bucket.exponent };

	for (const [index, transaction] of input.transactions.entries()) {
		const importedTransactionId = await persistTransaction(
			input.userId,
			transaction,
			input.accountId,
			input.importBatchId,
			input.source,
			denomination,
			dedupeKeys[index]
		);
		if (!importedTransactionId) {
			duplicateRows += 1;
			continue;
		}

		importedRows += 1;
		importedTransactionIds.push(importedTransactionId);
		if (transaction.metadata.type === 'expense')
			importedDebitCents += Math.abs(transaction.amountCents);
		if (transaction.metadata.type === 'income')
			importedCreditCents += Math.abs(transaction.amountCents);
	}

	// The figure the import summary discloses. `applyCategoryRules` has always returned how many
	// rows it rewrote and the count was always dropped here, so the one screen that reports what an
	// import did to the user's money could not mention the part of it the user did not ask for.
	const autoCategorizedRows = await applyCategoryRules(input.userId, {
		transactionIds: importedTransactionIds
	});
	await prisma.importBatch.update({
		where: { id: input.importBatchId },
		data: { importedRows, duplicateRows }
	});

	return {
		importedRows,
		duplicateRows,
		importedDebitCents,
		importedCreditCents,
		importedTransactionIds,
		autoCategorizedRows
	};
}

/**
 * Returns the created transaction id, or null when the row is a duplicate.
 *
 * Must never run inside a `prisma.$transaction`. It relies on catching a unique violation and
 * carrying on with the next row, and on PostgreSQL a constraint violation aborts the enclosing
 * transaction: every later statement would fail too, turning one duplicate into a failed
 * import. Both callers (routes/import, the bank-sync service) invoke it outside one.
 */
async function persistTransaction(
	userId: string,
	transaction: ImportedTransaction,
	accountId: string,
	importBatchId: string,
	source: string,
	denomination: { currency: string; exponent: number },
	dedupeKey: string | null
): Promise<string | null> {
	if (dedupeKey) {
		// Matched on the hash, never on the raw key: the raw comparison is the database's
		// opinion, and on an accent-insensitive collation it treats two different transactions
		// as one. See server/import/dedupeKey.ts.
		const existing = await prisma.transaction.findFirst({
			where: { userId, dedupeKeyHash: computeDedupeKeyHash(dedupeKey) }
		});
		if (existing) return null;
	}

	const category = await resolveCategoryByName(userId, transaction.category);

	let createdId: string;
	try {
		const created = await prisma.transaction.create({
			data: {
				...denomination,
				userId,
				accountId,
				categoryId: category.id,
				importBatchId,
				date: new Date(`${transaction.date}T00:00:00.000Z`),
				label: transaction.label,
				amountCents: Math.abs(transaction.amountCents),
				type: transaction.metadata.type,
				source,
				notes: transaction.metadata.notes || null,
				bankOperationType: transaction.metadata.bankOperationType || null,
				natureManual: transaction.metadata.natureManual ?? null,
				...dedupeKeyUpdate(dedupeKey),
				metadataJson: JSON.stringify({
					reference: transaction.metadata.reference,
					banquePopulaireCategory: transaction.metadata.banquePopulaireCategory,
					subcategory: transaction.metadata.subcategory,
					revolutType: transaction.metadata.revolutType,
					revolutProduct: transaction.metadata.revolutProduct,
					revolutCurrency: transaction.metadata.revolutCurrency,
					revolutState: transaction.metadata.revolutState,
					revolutFeeCents: transaction.metadata.revolutFeeCents,
					revolutBalanceCents: transaction.metadata.revolutBalanceCents,
					csvFields: sanitizeMetadataCsvFields(transaction.metadata.csvFields ?? {})
				})
			}
		});
		createdId = created.id;
	} catch (caught) {
		if (!isUniqueConstraintViolation(caught)) throw caught;

		// No dedupeKey means dedupeKeyHash is NULL, and a NULL never conflicts on
		// @@unique([userId, dedupeKeyHash]) on any of the three providers. So a conflict here is
		// a constraint this code did not anticipate, not a duplicate. Reporting it as one would
		// count a real transaction as already-imported and drop it without a word.
		if (!dedupeKey) throw caught;

		// The unique constraint now sits on `dedupeKeyHash`, so a conflict means another request
		// inserted the same fingerprint between the pre-check above and this insert: an ordinary
		// race, and the row really is a duplicate. That is the whole point of moving it there.
		// While the constraint was still on the raw key, the database's own equality could
		// disagree with the app's (an accent-insensitive collation, or an index covering only a
		// prefix of a long key), so this branch had to re-query before believing it.
		//
		// The re-query stays anyway, because it is the difference between "a duplicate" and "some
		// other constraint we did not anticipate". Reporting the second as a duplicate would drop
		// a real transaction and say nothing, which is the exact failure this column exists to
		// prevent.
		const conflictingRow = await prisma.transaction.findFirst({
			where: { userId, dedupeKeyHash: computeDedupeKeyHash(dedupeKey) },
			select: { id: true }
		});
		if (conflictingRow) return null;

		throw caught;
	}

	// Deliberately OUTSIDE the try. Inside it, a failure while writing the parts would be handed to
	// the duplicate branch above, which re-queries by dedupeKeyHash, finds the row THIS call just
	// inserted, and returns `null` — reporting a successful import as a duplicate and swallowing the
	// lost répartition. The parent is already committed by here, so nothing above can be confused
	// with anything below.
	await persistSplitParts(userId, createdId, transaction);
	return createdId;
}

/**
 * Writes an imported répartition through `replaceSplits`, the single write path — never a
 * `createMany` against `TransactionSplit`.
 *
 * An import is one of the three usual bypass suspects (restore, import, migration) precisely
 * because it builds rows before any service is in view, and the invariant it would bypass is the
 * one that makes every per-category figure in the app add up.
 *
 * MAGNITUDES, not signed amounts. `persistTransaction` above stores `Math.abs(amountCents)` on the
 * parent and puts the direction in `type`, and `replaceSplits` requires each part to carry the
 * PARENT ROW's sign — so signed parts summing to a signed total would be refused on a stored
 * positive parent. The profile has already checked that every part shares the total's sign, which
 * is what makes Σ|part| = |total| the same statement as Σ part = total.
 *
 * A refusal here is not an expected state of an import: everything `replaceSplits` can refuse is
 * already refused by the profile, with a line number, before a row is inserted. So it throws rather
 * than returning quietly — the alternative is a transaction that imported "successfully" with its
 * répartition silently missing, which is the shape no counter in the summary would report.
 */
async function persistSplitParts(
	userId: string,
	transactionId: string,
	transaction: ImportedTransaction
): Promise<void> {
	const parts = transaction.splitParts;
	if (!parts || parts.length === 0) return;

	const resolved = await Promise.all(
		parts.map(async (part) => ({
			categoryId: (await resolveCategoryByName(userId, part.category)).id,
			amountCents: Math.abs(part.amountCents)
		}))
	);

	const result = await replaceSplits(userId, transactionId, resolved);
	if (!result.ok) {
		throw new Error(`imported répartition refused by replaceSplits: ${result.reason}`);
	}
}

function sanitizeMetadataCsvFields(csvFields: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		METADATA_CSV_FIELD_ALLOWLIST.map((label) => [
			label,
			anonymizeImportCell(csvFields[label] ?? '')
		]).filter(([, value]) => value !== '')
	);
}
