import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from './events';

/**
 * Every write to the database has a logging decision (#1088). A file holding a Prisma write is
 * pinned with its number of write sites and with why its writes are or are not logged, so a new
 * write, in a new file or beside the pinned ones, fails here until someone answers « does this
 * change need a log line? ». Before this gate only deletes were pinned
 * (`sensitiveDeleteDoors.spec.ts`, which keeps its per-door map), and 23 create and update paths
 * shipped with no line and no decision (#1087).
 *
 * WHAT IT READS: every tracked `.ts`, `.js`, `.mjs` and `.svelte` under `src/` that is not a spec,
 * a db-smoke or generated, with comments removed so a comment naming a call cannot count. A script's
 * comments are removed by the TypeScript printer, which knows a string from a comment, so `'*\/*'`
 * or a URL cannot swallow the code after it (contradiction pass 1088-note-1, F3). A SITE is
 * `<model>.<write method>(`, the model list read from `prisma/schema.prisma` so a new model is read
 * without editing this file, with whitespace, `?.` and a type argument allowed between the parts so
 * a reflowed or generic call still counts; or a raw SQL call, which can write whatever its text says,
 * so its file is pinned and exempted rather than left out.
 *
 * WHEN IT FIRES: a site added, a site removed, a new file. NOT on an edit inside an existing site,
 * such as a nested `create:` added to an update's data, which is the issue's own scope. NOT on a
 * write SWAPPED for another in the same file, which keeps the count (F1); and a `logged:` decision
 * is checked to name a real event, not to be written by a call (F2), because the issue rules out a
 * per-door map for non-delete writes. The diff of a swap still shows both lines to a reviewer.
 * NOT READ, and none exists today: a delegate held in a variable or reached by brackets, a
 * `$extends` query override. NOT READ by design: anything outside `src/`, so the migrations' SQL run
 * at boot and the scripts under `scripts/`; and the driver adapter's own `executeRaw`
 * (`serializedSqliteAdapter.ts`), which forwards the statements Prisma sends.
 */

const ROOT = process.cwd();

const MODELS = [
	...readFileSync(`${ROOT}/prisma/schema.prisma`, 'utf8').matchAll(/^model (\w+) \{/gm)
].map(([, name]) => name[0].toLowerCase() + name.slice(1));

const METHODS = [
	'create',
	'createMany',
	'createManyAndReturn',
	'update',
	'updateMany',
	'updateManyAndReturn',
	'upsert',
	'delete',
	'deleteMany'
];

const SITE = new RegExp(
	`\\b(?:${MODELS.join('|')})\\s*\\??\\.\\s*(?:${METHODS.join('|')})\\s*(?:<[^<>()]*>\\s*)?\\(|\\$(?:execute|query)Raw(?:Unsafe)?\\s*[\`(]`,
	'g'
);

const printer = ts.createPrinter({ removeComments: true });

// A `.svelte` file is not a script, so its comments go by pattern; it cannot import the server
// client anyway, so a string holding `/*` there could only hide a write that cannot exist.
const withoutComments = (text: string, svelte: boolean) =>
	svelte
		? text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
		: printer.printFile(
				ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
			);

const sitesIn = (text: string, svelte = false) =>
	withoutComments(text, svelte).match(SITE)?.length ?? 0;

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
	.split('\n')
	.filter((path) => /\.(ts|js|mjs|svelte)$/.test(path))
	.filter((path) => !/\.spec\.[jt]s$|\.db-smoke\.ts$|\/paraglide\/|\/generated\//.test(path));

const measured = Object.fromEntries(
	files
		.map(
			(path) =>
				[path, sitesIn(readFileSync(`${ROOT}/${path}`, 'utf8'), path.endsWith('.svelte'))] as const
		)
		.filter(([, sites]) => sites > 0)
);

type Decision = `logged: ${string}` | `covered: #${number}${string}` | `exempt: ${string}`;

/**
 * Each file holding a write, its number of sites, and its decisions: `logged: <event>` names an
 * event of REGISTRY written for those writes, wherever the line is written (often the route that
 * calls the helper); `covered: #<n>` an open issue that decides them; `exempt: <reason>` why no
 * line is owed. A file whose writes differ lists one decision per kind.
 */
const DECISIONS: Record<string, { sites: number; decisions: Decision[] }> = {
	'src/lib/server/accounts/service.ts': {
		sites: 3,
		decisions: [
			'logged: sensitive_create',
			'covered: #1080, renaming and archiving a statement account are edits'
		]
	},
	'src/lib/server/ai/inferenceHalt.ts': {
		sites: 2,
		decisions: [
			'logged: budgetpilot.ai.inference_halted',
			'logged: budgetpilot.ai.inference_resumed'
		]
	},
	'src/lib/server/auth.ts': {
		sites: 10,
		decisions: [
			'logged: authn_login_success',
			'logged: user_created',
			'logged: session_logout',
			'logged: budgetpilot.session.settings_applied',
			'logged: budgetpilot.authn.reauth_success',
			'covered: #938, the other sessions a password or two-factor change ends',
			'exempt: a session end moved forward or its token rotated grants nothing new, and a cookie that stopped working writes budgetpilot.session.invalid',
			'exempt: signInFactorsStillCurrent writes back the hash it read, a guard that changes nothing',
			'exempt: pending second-factor challenges ended with a sign-in, the sign-in events record it'
		]
	},
	'src/lib/server/auth/invitations.ts': {
		sites: 2,
		decisions: ['logged: authz_admin']
	},
	'src/lib/server/auth/mfaChallenge.ts': {
		sites: 4,
		decisions: [
			'logged: budgetpilot.authn.second_factor_required',
			'exempt: expired or spent second-factor challenges, sign-in material recorded by the sign-in events'
		]
	},
	'src/lib/server/auth/rateLimit.ts': {
		sites: 2,
		decisions: [
			"exempt: the limiter's own record of an attempt and its expiry; a refused attempt writes excess_rate_limit_exceeded"
		]
	},
	'src/lib/server/auth/recoveryCodes.ts': {
		sites: 1,
		decisions: [
			'logged: authn_login_success',
			'logged: budgetpilot.authn.reauth_success',
			'covered: #1082, a code spent to turn two-factor off'
		]
	},
	'src/lib/server/auth/totpAcceptance.ts': {
		sites: 1,
		decisions: [
			'exempt: the last accepted code step, a replay guard; the sign-in or re-authentication it completes is logged'
		]
	},
	'src/lib/server/backup/import.ts': {
		sites: 36,
		decisions: ['logged: sensitive_delete']
	},
	'src/lib/server/banking/sync/service.ts': {
		sites: 12,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_update',
			'logged: sensitive_delete',
			'exempt: a bank authorization that has not completed grants no access (docs/logging.md, « What is not logged »)',
			'exempt: the bookkeeping of a sync: its start time, the expired status and the point the next sync fetches from'
		]
	},
	'src/lib/server/budget/dashboard.ts': {
		sites: 6,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_delete',
			'covered: #1080, a budget edited in place'
		]
	},
	'src/lib/server/categories/defaults.ts': {
		sites: 3,
		decisions: [
			'logged: sensitive_create',
			'exempt: the default categories an account starts with, chosen by the application at registration or first sign-in'
		]
	},
	'src/lib/server/categories/references.ts': {
		sites: 5,
		decisions: ['covered: #1080, a category rename carried to what names it']
	},
	'src/lib/server/categories/resolve.ts': {
		sites: 1,
		decisions: ['logged: sensitive_create', 'covered: #1080, the category a budget edit names']
	},
	'src/lib/server/categorization/defaultRules.ts': {
		sites: 2,
		decisions: [
			'logged: sensitive_create',
			'exempt: the default rules an account starts with, chosen by the application at registration or first sign-in'
		]
	},
	'src/lib/server/categorization/rules.ts': {
		sites: 1,
		decisions: ['covered: #1080, rules applied to existing transactions recategorise them']
	},
	'src/lib/server/database/advisoryLock.ts': {
		sites: 6,
		decisions: [
			'exempt: raw SELECTs that take, keep alive or release an advisory lock and read the database name; no row is written'
		]
	},
	'src/lib/server/database/privileges.ts': {
		sites: 1,
		decisions: [
			'exempt: a raw SELECT reading the role privileges; budgetpilot.database.overprivileged reports them'
		]
	},
	'src/lib/server/import/accountBackfill.ts': {
		sites: 2,
		decisions: ['logged: budgetpilot.backfill.completed']
	},
	'src/lib/server/import/accountMemory.ts': {
		sites: 4,
		decisions: ['logged: sensitive_delete', 'logged: sensitive_create']
	},
	'src/lib/server/import/dedupeBackfill.ts': {
		sites: 1,
		decisions: ['logged: budgetpilot.backfill.completed']
	},
	'src/lib/server/import/dedupeRecomputeBackfill.ts': {
		sites: 1,
		decisions: ['logged: budgetpilot.backfill.completed']
	},
	'src/lib/server/import/deleteBatch.ts': {
		sites: 2,
		decisions: ['logged: sensitive_delete']
	},
	'src/lib/server/import/mapping/store.ts': {
		sites: 3,
		decisions: ['logged: sensitive_create', 'logged: sensitive_delete']
	},
	'src/lib/server/import/persist.ts': {
		sites: 6,
		decisions: [
			'logged: sensitive_create',
			'exempt: deleteEmptyImportBatch removes a batch that its own where clause requires to hold no transaction'
		]
	},
	'src/lib/server/naming/backfill.ts': {
		sites: 18,
		decisions: ['logged: budgetpilot.backfill.completed']
	},
	'src/lib/server/net-worth/contestedRepair.ts': {
		sites: 1,
		decisions: ['logged: budgetpilot.net_worth.links_withdrawn']
	},
	'src/lib/server/net-worth/link.ts': {
		sites: 1,
		decisions: ['covered: #1080, an account linked to a net worth line']
	},
	'src/lib/server/net-worth/service.ts': {
		sites: 10,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_delete',
			'covered: #1080, a net worth line edited or relinked',
			'exempt: the balance kept for a linked account while a page is read, written by no member action'
		]
	},
	'src/lib/server/savings-goals/service.ts': {
		sites: 5,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_delete',
			'covered: #1080, a savings goal edited',
			'exempt: the date a goal was first seen reached and its dismissed banner, display state'
		]
	},
	'src/lib/server/tags/bulk.ts': {
		sites: 2,
		decisions: ['covered: #1080, tags applied to or removed from transactions are edits']
	},
	'src/lib/server/tags/service.ts': {
		sites: 7,
		decisions: [
			'logged: sensitive_delete',
			'covered: #1080, a tag created by tagging, renamed, recoloured or relinked'
		]
	},
	'src/lib/server/transactions/nature.ts': {
		sites: 2,
		decisions: ['logged: sensitive_delete', 'covered: #1080, the nature a category is given']
	},
	'src/lib/server/transactions/splits.ts': {
		sites: 5,
		decisions: ["covered: #1080, a transaction's splits replaced or cleared"]
	},
	'src/lib/server/upcoming-bills/service.ts': {
		sites: 3,
		decisions: ['logged: sensitive_create', 'logged: sensitive_delete']
	},
	'src/routes/admin/+page.server.ts': {
		sites: 5,
		decisions: ['logged: sensitive_delete', 'logged: authz_admin']
	},
	'src/routes/categories/+page.server.ts': {
		sites: 9,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_delete',
			'covered: #1080, a category renamed or given its default name',
			'exempt: dismissRenamePrompt stores that a prompt was dismissed, display state'
		]
	},
	'src/routes/force-password-change/+page.server.ts': {
		sites: 1,
		decisions: ['covered: #938, the forced password change']
	},
	'src/routes/register/+page.server.ts': {
		sites: 4,
		decisions: ['logged: user_created', 'logged: authz_admin']
	},
	'src/routes/rules/+page.server.ts': {
		sites: 4,
		decisions: [
			'logged: sensitive_create',
			'logged: sensitive_delete',
			'covered: #1080, a rule edited or switched on or off'
		]
	},
	'src/routes/settings/+page.server.ts': {
		sites: 10,
		decisions: [
			'logged: sensitive_delete',
			'logged: budgetpilot.authn.reauth_success',
			'covered: #938, a password change',
			'covered: #1082, two-factor turned on or off and the recovery codes it replaces'
		]
	},
	'src/routes/transactions/+page.server.ts': {
		sites: 6,
		decisions: [
			'logged: sensitive_delete',
			'logged: sensitive_create',
			'covered: #1080, a category, nature or suggestion set on transactions'
		]
	}
};

const QUESTION =
	'A Prisma write was added, removed or moved. Does this change need a log line? Name the event, ' +
	'the issue, or the exemption, in DECISIONS with the new site count (#1088). A file listed here ' +
	'that holds no Prisma write is an artefact: a variable named like a model (`session.delete(` on ' +
	'a Map) counts as one; rename the variable rather than pinning it.';

describe('every database write has a logging decision', () => {
	// The detector against shapes it must and must not count, so the figures below cannot come from
	// a pattern that matches nothing or everything.
	it('counts a write site, a reflowed one and raw SQL, and nothing else', () => {
		expect([
			sitesIn('await tx.transaction.create({ data })'),
			sitesIn('await prisma.netWorthAccount\n\t\t.updateMany({ where })'),
			sitesIn('await client.$executeRawUnsafe(sql); await client.$queryRaw`SELECT 1`'),
			sitesIn("createHash('sha256').update(token); cookies.delete(NAME); running.delete(c)"),
			sitesIn('$queryRaw: (template: TemplateStringsArray) => Promise<unknown>;'),
			sitesIn('// await prisma.user.delete({ where })\n/* tx.tag.create( */'),
			sitesIn('await tx.tag?.create({}); await tx.tag.upsert<Args>({})'),
			sitesIn("const glob = 'src/**/*.ts'; await prisma.tag.create({}); const end = '*/';"),
			sitesIn("fetch('https://example.test'); await prisma.tag.delete({})"),
			sitesIn('<!-- prisma.tag.create( -->\n<p>{label}</p>', true)
		]).toEqual([1, 1, 2, 0, 0, 0, 2, 1, 1, 0]);
	});

	it('reads the tree and every model of the schema', () => {
		expect([files.length > 300, MODELS.length, MODELS.includes('transaction')]).toEqual([
			true,
			26,
			true
		]);
	});

	it('finds the pinned total of write sites', () => {
		expect(
			Object.values(measured).reduce((total, sites) => total + sites, 0),
			QUESTION
		).toBe(210);
	});

	it('pins every file holding a write, with its number of sites', () => {
		const pinned = Object.fromEntries(
			Object.entries(DECISIONS).map(([path, { sites }]) => [path, sites])
		);
		expect(measured, QUESTION).toEqual(pinned);
	});

	it('gives every pinned file a decision in one of the three forms, naming a real event', () => {
		const malformed = Object.entries(DECISIONS).flatMap(([path, { decisions }]) =>
			(decisions.length === 0 ? ['(none)'] : decisions)
				.filter((decision) => {
					const logged = /^logged: (\S+)/.exec(decision);
					if (logged) return !(logged[1] in REGISTRY);
					return !/^covered: #\d+\b|^exempt: .{20,}/.test(decision);
				})
				.map((decision) => `${path}: ${decision}`)
		);
		expect([Object.keys(DECISIONS).length, malformed]).toEqual([42, []]);
	});
});
