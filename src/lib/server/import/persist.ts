import { applyCategoryRules } from '$lib/server/categorization/rules';
import { prisma } from '$lib/server/db';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { anonymizeDetailText } from '$lib/server/transactions/anonymize';
import { resolveCategoryByName } from '$lib/server/categories/resolve';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash, dedupeKeyUpdate } from '$lib/server/import/dedupeKey';
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
	currency?: string;
	/** Applied only when the bucket is first created — an existing bucket's link is never silently changed by a later import. */
	netWorthAccountId?: string | null;
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
 * Resolves (or creates) the technical Account bucket a batch of imported transactions
 * lands on, keyed by the (userId, name, source) unique constraint.
 */
export async function resolveImportBucketAccount(
	input: ImportBucketInput
): Promise<ImportBucketResult> {
	if (input.providerAccountId) {
		const byProviderAccount = await prisma.account.findFirst({
			where: {
				userId: input.userId,
				source: input.source,
				providerAccountId: input.providerAccountId
			},
			select: { id: true, bankConnectionId: true }
		});
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

	let name = input.name;
	// Folded match, like categories: a bucket named "Courses" and an import announcing
	// "courses" are the same bucket, and creating a second one would split the history.
	//
	// Ordered, unlike the category lookup next door, because more than one row can match here.
	// `Account` is the one name-keyed table with no unique constraint on its key: the name-key
	// backfill deliberately refuses to merge two buckets carrying conflicting bank or net-worth
	// links, and leaves both in place. An unordered `findFirst` would then be free to answer
	// with a different bucket on each call — stable on SQLite, arbitrary on PostgreSQL — and
	// the same import would scatter its rows. Oldest first, matching the survivor rule the
	// merge plan uses, so both agree on which bucket is the real one.
	const existing = await prisma.account.findFirst({
		where: { userId: input.userId, nameKey: computeNameKey(name), source: input.source },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: { id: true }
	});
	if (existing) {
		if (!input.providerAccountId) return { accountId: existing.id, created: false };
		// The name is held by a bucket mapped to a DIFFERENT provider account (or none):
		// disambiguate with an opaque suffix (never the raw uid) instead of merging.
		name = `${input.name} · ${hashFingerprint(input.providerAccountId).slice(0, 6)}`;
	}

	// Upsert (not create) so a concurrent first import of the same bucket cannot throw.
	const account = await prisma.account.upsert({
		where: { userId_name_source: { userId: input.userId, name, source: input.source } },
		update: {},
		create: {
			userId: input.userId,
			name,
			nameKey: computeNameKey(name),
			source: input.source,
			currency: input.currency ?? 'EUR',
			netWorthAccountId: input.netWorthAccountId ?? null,
			bankConnectionId: input.bankConnectionId ?? null,
			providerAccountId: input.providerAccountId ?? null,
			providerCashAccountType: input.providerCashAccountType ?? null
		}
	});
	return { accountId: account.id, created: true };
}

export interface CreateImportBatchInput {
	userId: string;
	source: string;
	fileName: string;
	profile: string;
	rowCount: number;
	invalidRows: number;
	/** ISO dates (YYYY-MM-DD) or null when the batch has no valid dated row. */
	period: { from: string | null; to: string | null };
}

/** Creates the ImportBatch row a persistence run reports into; returns its id. */
export async function createImportBatch(input: CreateImportBatchInput): Promise<string> {
	const batch = await prisma.importBatch.create({
		data: {
			userId: input.userId,
			source: input.source,
			fileName: input.fileName,
			profile: input.profile,
			rowCount: input.rowCount,
			invalidRows: input.invalidRows,
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

	for (const transaction of input.transactions) {
		const importedTransactionId = await persistTransaction(
			input.userId,
			transaction,
			input.accountId,
			input.importBatchId,
			input.source
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

	await applyCategoryRules(input.userId, { transactionIds: importedTransactionIds });
	await prisma.importBatch.update({
		where: { id: input.importBatchId },
		data: { importedRows, duplicateRows }
	});

	return {
		importedRows,
		duplicateRows,
		importedDebitCents,
		importedCreditCents,
		importedTransactionIds
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
	source: string
): Promise<string | null> {
	const dedupeKey = transaction.metadata.deduplicationKey;
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

	try {
		const created = await prisma.transaction.create({
			data: {
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
		return created.id;
	} catch (caught) {
		if (!isUniqueConstraintError(caught)) throw caught;

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
}

function sanitizeMetadataCsvFields(csvFields: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		METADATA_CSV_FIELD_ALLOWLIST.map((label) => [
			label,
			anonymizeImportCell(csvFields[label] ?? '')
		]).filter(([, value]) => value !== '')
	);
}

function isUniqueConstraintError(caught: unknown): boolean {
	return (
		typeof caught === 'object' &&
		caught !== null &&
		'code' in caught &&
		(caught as { code?: string }).code === 'P2002'
	);
}
