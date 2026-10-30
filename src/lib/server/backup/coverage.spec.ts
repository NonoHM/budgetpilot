import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { backupExportSchema } from './schema';

/**
 * Every model in schema.prisma is either carried by the backup export or listed here with the
 * reason it is not. Nothing may be absent from both.
 *
 * Without this, adding a table and forgetting `backup/` produces no red test, and the omission is
 * only discovered by a user whose restore silently drops their data. That is the same shape as the
 * gates that were structurally blind in #97: green, and never looking at the file in question. It
 * is also the shape that rejected an implicit many-to-many for TransactionTag, whose synthesized
 * join table no gate in this repo can see.
 *
 * Adding a model here is a deliberate act that needs a reason, not a shrug.
 */
const NOT_EXPORTED: Record<string, string> = {
	// The account itself, restored into an existing session rather than recreated.
	User: 'the restore target, never part of its own payload',
	// Auth surface: exporting any of it would put credentials or live sessions in a file the user
	// downloads, and restoring it would resurrect revoked access.
	Session: 'live authentication state, must never leave the database',
	RecoveryCode: 'MFA secret material',
	PendingMfaChallenge: 'ephemeral authentication state',
	Invitation: 'addressed to a person, not owned data; carries a token hash',
	LoginAttempt: 'rate-limiting state, keyed by HMAC, not user data',
	InferenceHalt: "the instance-wide AI halt (#986), set by an admin; not any member's data",
	BankAuthorizationRequest: 'ephemeral OAuth state with encrypted payloads',
	// #599: keyed by a hash under this instance's secret, so it never matches on another one, and
	// every row carries an account identifier fragment, which a plaintext file must not (#468).
	RememberedAccount: 'instance-keyed memory carrying account identifier fragments (#468)',
	// Join model with a composite primary key: it has no id of its own and is carried by the
	// `transactionTags` pair array rather than as a keyed table.
	TransactionTag: 'exported as the transactionTags pair array, not as a keyed table'
};

/**
 * schema.prisma model name -> the export key carrying it, where the two differ.
 * Everything else is expected to be the camelCase plural of the model name.
 */
const EXPORT_KEY_OVERRIDES: Record<string, string> = {
	Tag: 'tags',
	// The naive pluralizer below yields `importBatchs`. Listed rather than teaching the pluralizer
	// about sibilants: an explicit entry is checked against the real export key, whereas a cleverer
	// rule is one more thing that can be silently wrong.
	ImportBatch: 'importBatches'
};

function modelNames(): string[] {
	const schema = readFileSync('prisma/schema.prisma', 'utf8');
	return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

function expectedExportKey(model: string): string {
	if (EXPORT_KEY_OVERRIDES[model]) return EXPORT_KEY_OVERRIDES[model];
	const head = model.charAt(0).toLowerCase() + model.slice(1);
	return head.endsWith('y') ? `${head.slice(0, -1)}ies` : `${head}s`;
}

/**
 * Read WITHOUT a `?? {}` fallback, deliberately.
 *
 * The plan for this gate warned that `backupExportSchema` might be a ZodEffects after the
 * `superRefine` in schema.ts, and suggested falling back to `_def.schema.shape`. Both halves were
 * checked against zod 4.4.3 rather than assumed, and it is the other way round: `superRefine`
 * returns a ZodObject whose `.shape` is intact, and `_def.schema` is undefined.
 *
 * That matters more than it looks. Written as `(backupExportSchema.shape ?? {})` with the
 * suggested fallback, this set would silently be empty on any zod version that DID wrap, every
 * `toContain` below would fail loudly, and the natural fix would be to make it lenient. Written as
 * a bare read plus the emptiness assertion below, a wrapper change fails as a missing property
 * rather than as a gate that quietly matches nothing.
 */
const exportKeys = new Set(Object.keys(backupExportSchema.shape));

describe('backup schema coverage', () => {
	it('finds the models in schema.prisma', () => {
		// Guards the regex itself: a rename of the file, or a formatting change that made this
		// match nothing, would otherwise make every assertion below vacuously pass.
		expect(modelNames().length).toBeGreaterThan(15);
	});

	it('reads the export keys off the schema, rather than an empty set', () => {
		// The companion guard to the one above, for the other input. A gate that silently matches
		// nothing is worse than no gate: this one fails if `.shape` ever stops resolving.
		expect(exportKeys.size).toBeGreaterThan(10);
		expect(exportKeys).toContain('transactions');
	});

	it.each(modelNames())('%s is exported or explicitly excluded', (model) => {
		if (NOT_EXPORTED[model]) {
			expect(NOT_EXPORTED[model].length).toBeGreaterThan(10);
			return;
		}
		expect(exportKeys).toContain(expectedExportKey(model));
	});

	it('has no stale entry in the exclusion list', () => {
		const models = new Set(modelNames());
		for (const excluded of Object.keys(NOT_EXPORTED)) {
			expect(models).toContain(excluded);
		}
	});
});

/**
 * Every COLUMN of every exported model is either carried by its backup array or listed below with
 * the reason it is not (#1173). The model-level gate above cannot see a dropped column: it is how
 * `CategoryRule.isRegex` left every backup, and a regex rule came back as a literal that matched
 * nothing while the rule list looked the same.
 *
 * Two lists, and the split is the assertion. ALWAYS_DERIVED holds the one column no model may carry;
 * NOT_CARRIED holds the per-model ones. A NOT_CARRIED entry that IS carried fails, and so does an
 * entry naming a column that does not exist, so an exclusion cannot outlive its reason and mask the
 * column afterwards (#467 is that hole in the model-level gate). `createdAt` and `updatedAt` are per
 * model and never in ALWAYS_DERIVED: `CategoryRule` carries the first as its rule priority,
 * `RecurringStreamAction` carries both, and a shared entry would hide either going missing.
 *
 * What it reads is the schema DECLARATION. That export.ts writes a declared column and import.ts
 * writes it back is not seen here: a column declared with a default and left out of the export is
 * the #1173 shape and passes. The round trip is `categoryRuleRoundTrip.db-smoke.ts` for
 * CategoryRule, and nothing yet for the other models. One live instance: `Category.defaultKey` is
 * declared, so it reads as carried, while the export never writes it and the restore ignores it.
 */
const ALWAYS_DERIVED: Record<string, string> = {
	userId: 'the restore target, derived from the session and never read from a file'
};

const NOT_CARRIED: Record<string, string> = {
	'Account.nameKey': 'recomputed by the restore with computeNameKey',
	'Account.discriminant': 'identifier fragment refused by design, see the schema comment (#468)',
	'Account.institution': 'not carried yet, see #1176',
	'Account.archivedAt': 'not carried yet, see #1176',
	'Account.createdAt': 'restore time, see #1178',
	'BankConnection.providerSessionId': 'a secret: a restored connection never comes back usable',
	'BankConnection.credentialsEncrypted': 'a secret: a restored connection never comes back usable',
	'BankConnection.lastSyncStatus': 'sync state of a connection that cannot sync once restored',
	'BankConnection.lastSyncError': 'sync state of a connection that cannot sync once restored',
	'BankConnection.createdAt': 'restore time, see #1178',
	'Category.nameKey': 'recomputed by the restore with computeNameKey',
	'Category.createdAt': 'restore time, see #1178',
	'Tag.nameKey': 'recomputed by the restore with computeNameKey',
	'Tag.createdAt': 'restore time, see #1178',
	'TransactionSplit.createdAt': 'restore time, see #1178',
	'Transaction.manualCategoryKey': 'recomputed by the restore through manualCategoryUpdate',
	'Transaction.dedupeKeyHash':
		'recomputed by the restore, because the key names the new account id',
	'Transaction.createdAt': 'restore time, see #1178',
	'ImportBatch.accountId': 'not carried yet, see #1177',
	'ImportBatch.columnMappingId': 'not carried yet, see #1177',
	'ImportBatch.dateOrder': 'not carried yet, see #1177',
	'ImportBatch.createdAt': 'restore time, see #1178',
	'ColumnMapping.id': 'not carried yet, so a batch cannot be linked back, see #1177',
	'ColumnMapping.lastUsedAt': 'not portable state worth carrying, see the comment in export.ts',
	'ColumnMapping.createdAt': 'restore time, see #1178',
	'CategorizationRule.createdAt': 'restore time, see #1178',
	'MonthlyBudget.categoryNameKey': 'recomputed by the restore with computeNameKey',
	'MonthlyBudget.createdAt': 'restore time, see #1178',
	'CategoryNatureMapping.categoryNameKey': 'recomputed by the restore with computeNameKey',
	'CategoryNatureMapping.createdAt': 'restore time, see #1178',
	'NetWorthAccount.nameKey': 'recomputed by the restore with computeNameKey',
	'NetWorthAccount.createdAt': 'restore time, see #1178',
	'SavingsGoal.deletedAt': 'a deleted goal is not exported at all, see export.ts',
	'SavingsGoal.createdAt': 'restore time, see #1178',
	'Account.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'BankConnection.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'Category.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'Tag.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'TransactionSplit.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'Transaction.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'ImportBatch.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'ColumnMapping.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'CategorizationRule.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'CategoryRule.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'MonthlyBudget.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'CategoryNatureMapping.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'NetWorthAccount.updatedAt': 'set by Prisma on the write, and the restore is that write',
	'SavingsGoal.updatedAt': 'set by Prisma on the write, and the restore is that write'
};

/** Scalar columns per model: a field whose type is another model is a relation, not a column. */
function scalarColumns(): Map<string, string[]> {
	const schema = readFileSync('prisma/schema.prisma', 'utf8');
	const blocks = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
	const models = new Set(blocks.map((block) => block[1]));
	return new Map(
		blocks.map(([, model, body]) => [
			model,
			body
				.split('\n')
				.map((line) => line.trim().split(/\s+/))
				.filter(([field, type]) => /^\w+$/.test(field) && type !== undefined)
				.filter(([, type]) => !models.has(type.replace(/[?[\]]/g, '')))
				.map(([field]) => field)
		])
	);
}

/** The keys of one row of a backup array, or a throw: never an empty set that passes everything. */
function carriedColumns(exportKey: string): string[] {
	const root = (backupExportSchema.shape as Record<string, unknown>)[exportKey] as {
		element?: { shape?: object };
		unwrap?: () => { element?: { shape?: object } };
	};
	const element = root.element ?? root.unwrap?.().element;
	if (!element?.shape) throw new Error(`${exportKey} has no row shape this guard can read`);
	return Object.keys(element.shape);
}

describe('backup column coverage', () => {
	const exported = [...scalarColumns()].filter(([model]) => !NOT_EXPORTED[model]);

	it('reads the columns of the exported models, rather than an empty list', () => {
		// Starting figures measured on 2026-10-30, so a parser matching nothing cannot pass below.
		expect(exported.length).toBeGreaterThan(15);
		expect(exported.flatMap(([, columns]) => columns).length).toBeGreaterThan(150);
		expect(Object.fromEntries(exported).CategoryRule).toContain('isRegex');
	});

	it.each(exported)('every column of %s is carried or excluded with a reason', (model, columns) => {
		const carried = carriedColumns(expectedExportKey(model));
		const unaccounted = columns.filter(
			(column) =>
				!carried.includes(column) && !ALWAYS_DERIVED[column] && !NOT_CARRIED[`${model}.${column}`]
		);
		expect(unaccounted).toEqual([]);
	});

	it('has no exclusion that is also carried, or that names no column', () => {
		const columns = new Map(exported);
		const wrong: string[] = [];
		for (const entry of Object.keys(NOT_CARRIED)) {
			const [model, column] = entry.split('.');
			if (!columns.get(model)?.includes(column)) wrong.push(`${entry}: no such exported column`);
			else if (carriedColumns(expectedExportKey(model)).includes(column))
				wrong.push(`${entry}: carried`);
		}
		for (const [model] of exported) {
			for (const column of carriedColumns(expectedExportKey(model))) {
				if (ALWAYS_DERIVED[column]) wrong.push(`${model}.${column}: carried but always derived`);
			}
		}
		expect(wrong).toEqual([]);
	});
});

/**
 * The backup reference page lists every root key of the export, and the list is checked here
 * rather than trusted.
 *
 * `docs/reference/backup-restore.md` said "Nineteen top-level keys, read off a real export" and
 * listed nineteen. There were twenty: `columnMappings` arrived with the column-mapping work,
 * defaulted so that no existing file broke, and nothing failed and nothing re-read the page.
 *
 * That phrase is what makes this worth a gate rather than a correction. "Read off a real export"
 * is a claim about METHOD, and a reader who finds it wrong by one loses their reason to trust the
 * other figures on the page, including the ones that are right. Either the claim gets something
 * that re-derives it, or it should not be made. This is that something.
 *
 * Parsed out of the page's own list rather than from a copy kept here, because a copy would be a
 * second source and the two would drift in exactly the way this exists to stop.
 */
describe('the backup reference page', () => {
	const REFERENCE = 'docs/reference/backup-restore.md';

	function documentedKeys(): string[] {
		const page = readFileSync(REFERENCE, 'utf8');
		// The list is the run of backticked names following the "top-level keys" sentence, which is
		// how the page has always written it.
		const heading = page.indexOf('top-level keys');
		if (heading === -1) throw new Error(`${REFERENCE} no longer names its top-level keys`);
		// The list is the paragraph AFTER the sentence, so the search starts at the first backtick
		// past it and ends at the blank line closing that paragraph. Slicing from the sentence
		// itself stops at the blank line separating the two, which is how the first version of this
		// helper returned nothing and reported it as a page listing no keys.
		const listStart = page.indexOf('`', heading);
		if (listStart === -1) throw new Error(`${REFERENCE} names its keys but lists none`);
		const listEnd = page.indexOf('\n\n', listStart);
		const list = page.slice(listStart, listEnd === -1 ? undefined : listEnd);
		return [...list.matchAll(/`(\w+)`/g)].map((match) => match[1]);
	}

	it('reads a list off the page rather than an empty match', () => {
		// The companion guard to every other emptiness check in this file: a regex that matched
		// nothing would make the comparison below pass by comparing two empty sets.
		expect(documentedKeys().length).toBeGreaterThan(10);
	});

	it('lists exactly the keys the schema declares', () => {
		expect([...documentedKeys()].sort()).toEqual([...exportKeys].sort());
	});

	it('states a count that matches the list it gives', () => {
		const page = readFileSync(REFERENCE, 'utf8');
		// LONGEST ALTERNATIVE FIRST, and the order is the assertion rather than a tidiness.
		// `-` is not a word character, so `\bTwenty\b` matches INSIDE "Twenty-one": written with
		// `Twenty` before the hyphenated forms, this regex reads a page saying twenty-one as
		// saying twenty, and the mismatch it then reports is the regex's own. Measured when the
		// twenty-first key arrived: the page had been corrected and this test still failed,
		// naming 20 against 21.
		const spelled = /\b(Nineteen|Twenty-two|Twenty-one|Twenty)\b/.exec(page);
		expect(spelled, `${REFERENCE} should spell its key count`).not.toBeNull();
		const asNumber: Record<string, number> = {
			Nineteen: 19,
			Twenty: 20,
			'Twenty-one': 21,
			'Twenty-two': 22
		};
		expect(asNumber[spelled![1]]).toBe(exportKeys.size);
	});
});
