import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every bulk destruction of transactions writes `sensitive_delete` (#250 L4b-2). The writers are
 * few and the route logs, not the helper (the helper knows no actor for an admin's delete), so the
 * gate is a MIRROR: the set of files that destroy transactions, directly or through the two
 * relations that cascade into them (`User`, `Account`, schema.prisma), is pinned, and each door is
 * pinned to a `logSensitiveDelete` call carrying ITS operation, so a file holding two doors cannot
 * pass on one call (contradiction pass F4). A new writer fails the first test, which forces the
 * question « is this a bulk delete? » rather than letting it pass unread.
 *
 * WHAT IT READS: every tracked `.ts` under `src/` that is not a spec, a db-smoke or generated, with
 * comments removed so a comment naming a call cannot stand in for it. ITS PREMISE: a writer calls
 * the Prisma model by its usual name (`transaction`, `user`, `account` or `importBatch`, then
 * `.delete` or `.deleteMany`); a model reached through a variable, or raw SQL, is not read. None
 * exists today.
 *
 * REV 3 (owner ruling 3, « everything gets traced »): every deletion of table A, one row included,
 * so the mirror also reads the models of the one-row deletes, and a HELPER is pinned by its own
 * module and every file importing it from there, whatever local name the import gives it: settings
 * imports `deleteTag` as `deleteTagService`, and a name-based caller search does not see that door.
 * A helper whose own body logs (`pruneOrphanTags`, the only place that knows it deleted) is its own
 * door, and its importers are pinned without being doors.
 *
 * REV 3b: the gate pins the NUMBER of writer call sites per file, so a new delete inside a file
 * already pinned fails too (a file-level mirror let three member deletions through, in files whose
 * other delete was a door). The regex reads every model table A deletes from, the restore's purge
 * included, and `session`, whose deletes are part of the two account deletes.
 *
 * The writers that destroy no member data are named in NOT_A_DOOR with the reason, rather than
 * silently excluded.
 */

const ROOT = process.cwd();
const WRITER =
	/\b(?:transaction|user|account|session|importBatch|tag|category|categoryRule|categorizationRule|monthlyBudget|columnMapping|rememberedAccount|categoryNatureMapping|bankConnection|recurringStreamAction|savingsGoal|netWorthSnapshot|netWorthAccount)\.delete(?:Many)?\(/g;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => path.endsWith('.ts'))
	.filter((path) => !/\.spec\.ts$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

const code = (path: string) =>
	readFileSync(`${ROOT}/${path}`, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');

const sitesIn = (path: string) => code(path).match(WRITER)?.length ?? 0;
const writerSites = Object.fromEntries(
	files.map((path) => [path, sitesIn(path)] as const).filter(([, sites]) => sites > 0)
);

/**
 * Every writer file and how many writer call sites it holds. A new site in any of them, or a new
 * file, fails, and forces the question « which operation of table A is this, or why is it not one? »
 */
const WRITER_SITES: Record<string, number> = {
	// The purge: sixteen models, one restore.
	'src/lib/server/backup/import.ts': 16,
	'src/lib/server/banking/sync/service.ts': 1,
	// deleteBudget, and the merge in updateBudget.
	'src/lib/server/budget/dashboard.ts': 2,
	// The overrule in rememberAnsweredAccount, and forgetRememberedAccount.
	'src/lib/server/import/accountMemory.ts': 2,
	// The batch's transactions, then the batch.
	'src/lib/server/import/deleteBatch.ts': 2,
	'src/lib/server/import/mapping/store.ts': 1,
	'src/lib/server/import/persist.ts': 1,
	'src/lib/server/naming/backfill.ts': 4,
	// deleteTag and pruneOrphanTags.
	'src/lib/server/tags/service.ts': 2,
	'src/lib/server/transactions/nature.ts': 1,
	// The prune in recordStreamAction, and undoStreamAction.
	'src/lib/server/upcoming-bills/service.ts': 2,
	// deleteUser: sessions, transactions, user; resetPassword: sessions.
	'src/routes/admin/+page.server.ts': 4,
	// deleteCategory: nature mapping, budget, category.
	'src/routes/categories/+page.server.ts': 3,
	'src/routes/rules/+page.server.ts': 1,
	// deleteAccount: sessions, transactions, user.
	'src/routes/settings/+page.server.ts': 3,
	'src/routes/transactions/+page.server.ts': 1
};

type Door = [door: string, operation: string];

const SETTINGS = 'src/routes/settings/+page.server.ts';
const CATEGORIES = 'src/routes/categories/+page.server.ts';

/** The routes that delete through Prisma themselves, and the operation each logs. */
const ROUTE_DOORS: Door[] = [
	[SETTINGS, 'delete_account'],
	['src/routes/admin/+page.server.ts', 'delete_user'],
	['src/routes/transactions/+page.server.ts', 'delete_transaction'],
	[CATEGORIES, 'delete_category'],
	['src/routes/rules/+page.server.ts', 'delete_rule']
];

/**
 * Each helper by its module and export, every door into it with the operation that door logs, and
 * the files importing it when they are not the doors (a helper that logs itself).
 */
const HELPERS: { module: string; name: string; doors: Door[]; importers?: string[] }[] = [
	{
		module: 'src/lib/server/backup/import.ts',
		name: 'restoreBackup',
		doors: [[SETTINGS, 'restore']]
	},
	{
		module: 'src/lib/server/import/deleteBatch.ts',
		name: 'deleteImportBatch',
		doors: [
			['src/routes/imports/+page.server.ts', 'import_cancel'],
			['src/routes/import/columns/+page.server.ts', 'import_replace']
		]
	},
	{
		module: 'src/lib/server/tags/service.ts',
		name: 'deleteTag',
		doors: [[SETTINGS, 'delete_tag']]
	},
	{
		module: 'src/lib/server/tags/service.ts',
		name: 'pruneOrphanTags',
		doors: [['src/lib/server/tags/service.ts', 'prune_tags']],
		importers: ['src/lib/server/tags/bulk.ts']
	},
	{
		module: 'src/lib/server/budget/dashboard.ts',
		name: 'deleteBudget',
		doors: [['src/routes/budgets/+page.server.ts', 'delete_budget']]
	},
	{
		module: 'src/lib/server/import/mapping/store.ts',
		name: 'deleteColumnMapping',
		doors: [[SETTINGS, 'delete_column_mapping']]
	},
	{
		module: 'src/lib/server/import/accountMemory.ts',
		name: 'forgetRememberedAccount',
		doors: [[SETTINGS, 'forget_remembered_account']]
	},
	{
		module: 'src/lib/server/transactions/nature.ts',
		name: 'deleteCategoryNatureMapping',
		doors: [[CATEGORIES, 'delete_nature_mapping']]
	},
	{
		module: 'src/lib/server/banking/sync/service.ts',
		name: 'deleteBankConnection',
		doors: [['src/routes/imports/bank-connections/+page.server.ts', 'delete_bank_connection']]
	},
	{
		module: 'src/lib/server/upcoming-bills/service.ts',
		name: 'undoStreamAction',
		doors: [['src/routes/upcoming-bills/+page.server.ts', 'undo_bill_action']]
	},
	// Rev 3b: three helpers that log themselves, each the only place that knows it deleted.
	{
		module: 'src/lib/server/budget/dashboard.ts',
		name: 'updateBudget',
		doors: [['src/lib/server/budget/dashboard.ts', 'merge_budget']],
		importers: ['src/routes/budgets/+page.server.ts']
	},
	{
		module: 'src/lib/server/import/accountMemory.ts',
		name: 'rememberAnsweredAccount',
		doors: [['src/lib/server/import/accountMemory.ts', 'overrule_remembered_account']],
		importers: ['src/routes/import/+page.server.ts', 'src/routes/import/columns/+page.server.ts']
	},
	{
		module: 'src/lib/server/upcoming-bills/service.ts',
		name: 'recordStreamAction',
		doors: [['src/lib/server/upcoming-bills/service.ts', 'prune_bill_actions']],
		importers: ['src/routes/upcoming-bills/+page.server.ts']
	}
];

/** Writer sites that destroy no member data, each with why. */
const NOT_A_DOOR: [path: string, reason: string][] = [
	[
		'src/lib/server/import/persist.ts',
		'deleteEmptyImportBatch: its own where clause requires the batch to hold no transactions'
	],
	[
		'src/lib/server/naming/backfill.ts',
		'the boot merge deletes duplicates only after moving their rows to the survivor'
	],
	[
		'src/routes/admin/+page.server.ts',
		"resetPassword ends the target's sessions: not member data, recorded by authz_admin reset_password"
	]
];

/** The repository path an import specifier names, without its extension; null for a package. */
function resolveSpecifier(from: string, specifier: string): string | null {
	const path = specifier.startsWith('$lib/')
		? `src/lib/${specifier.slice('$lib/'.length)}`
		: specifier.startsWith('.')
			? posix.join(posix.dirname(from), specifier)
			: null;
	return path?.replace(/\.(ts|js)$/, '') ?? null;
}

/**
 * The files importing `name` from `module`, read from the import statements, so an alias
 * (`deleteTag as deleteTagService`) and a namespace import both count. A type-only import cannot
 * call, so it does not.
 */
function importersOf(module: string, name: string): string[] {
	const target = module.replace(/\.ts$/, '');
	const statement =
		/\b(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/g;
	const named = new RegExp(`^${name}(?:\\s+as\\s+\\w+)?$`);
	return files
		.filter((path) =>
			[...code(path).matchAll(statement)].some(
				([, typeOnly, names, specifier]) =>
					!typeOnly &&
					resolveSpecifier(path, specifier) === target &&
					(names === undefined ||
						names
							.split(',')
							.map((part) => part.trim())
							.some((part) => named.test(part)))
			)
		)
		.sort();
}

const doors = [...ROUTE_DOORS, ...HELPERS.flatMap((helper) => helper.doors)];

describe('every deletion a member or admin triggers logs sensitive_delete', () => {
	// The first figures calibrate: the files were read, and the sites found are the 46 pinned.
	it('reads the files and finds exactly the known writer sites, file by file', () => {
		expect([
			files.length > 100,
			Object.values(writerSites).reduce((total, sites) => total + sites, 0),
			writerSites
		]).toEqual([true, 46, WRITER_SITES]);
	});

	// Every writer file is a door, a helper's module or a named non-door, and nothing else.
	it('classifies every writer file', () => {
		expect(Object.keys(WRITER_SITES).sort()).toEqual(
			[
				...new Set([
					...ROUTE_DOORS.map(([path]) => path),
					...HELPERS.map((helper) => helper.module),
					...NOT_A_DOOR.map(([path]) => path)
				])
			].sort()
		);
	});

	// The operation literal is matched inside a `logSensitiveDelete(` call, so a file with several
	// doors needs every call. The first two figures calibrate: nineteen doors were read, one per
	// operation of table A (rev 3b).
	it('each door calls logSensitiveDelete with its own operation', () => {
		const call = (operation: string) => new RegExp(`logSensitiveDelete\\([^;]*'${operation}'`, 's');
		expect([
			doors.length,
			new Set(doors.map(([, operation]) => operation)).size,
			doors.filter(([path, operation]) => !call(operation).test(code(path))).map(String)
		]).toEqual([19, 19, []]);
	});

	// By module, not by local name. The settings door imports `deleteTag` as `deleteTagService`: a
	// detector that cannot see the alias reports no importer for it and fails this row.
	it('each helper is imported only by its listed files', () => {
		expect(HELPERS.map((helper) => [helper.name, importersOf(helper.module, helper.name)])).toEqual(
			HELPERS.map((helper) => [
				helper.name,
				[...new Set(helper.importers ?? helper.doors.map(([path]) => path))].sort()
			])
		);
	});

	it('each bulk helper is called only from its listed doors', () => {
		const callers = (name: string) =>
			files.filter((path) => new RegExp(`\\b${name}\\(`).test(code(path))).sort();
		expect([callers('restoreBackup'), callers('deleteImportBatch')]).toEqual([
			['src/lib/server/backup/import.ts', 'src/routes/settings/+page.server.ts'],
			[
				'src/lib/server/import/deleteBatch.ts',
				'src/routes/import/columns/+page.server.ts',
				'src/routes/imports/+page.server.ts'
			]
		]);
	});
});
