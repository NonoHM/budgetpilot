import { assertBootstrapTokenConfigured } from '$lib/server/auth/bootstrapToken';
import { assertRateLimitSecretConfigured } from '$lib/server/auth/rateLimit';
import { assertBackupBoundConfigured } from '$lib/server/backup/parseBounds';
import { assertEncryptionKeyConfigured } from '$lib/server/crypto';
import { assertDatabaseConfigured } from '$lib/server/database/bootCheck';
import { assertCsvColumnBoundConfigured } from '$lib/server/import/columnBounds';
import { assertColumnMappingCapConfigured } from '$lib/server/import/mapping/store';
import { assertXlsxBoundConfigured } from '$lib/server/import/zipBounds';
import { assertForwardingConfigSafe } from '$lib/server/net/clientAddress';

type Check = [name: string, run: () => void | Promise<void>];

/**
 * Runs every check and returns the messages of the ones that failed, instead of stopping at the
 * first.
 *
 * Kept separate from `assertEnvironmentConfigured` so the collection behaviour can be tested on
 * its own: standing up eleven real configuration failures to assert "it did not stop at the first"
 * would make the spec a test of eleven other modules, and the property under test here is the
 * loop.
 */
export async function collectEnvironmentProblems(checks: Check[]): Promise<string[]> {
	const problems: string[] = [];
	for (const [name, run] of checks) {
		try {
			await run();
		} catch (caught) {
			problems.push(caught instanceof Error ? caught.message : `${name}: ${String(caught)}`);
		}
	}
	return problems;
}

/**
 * The single boot-time configuration gate.
 *
 * **Why it collects rather than fails fast.** An operator installing this for the first time met
 * FOUR consecutive failed boots, each revealing exactly one more variable, because every phase
 * stopped at its first failure and nothing accumulated. Three of the four messages named a
 * variable without naming its format, so setting the variable earned another boot rather than a
 * running app.
 *
 * **And a second reason, independent of ergonomics, which is what makes this a correctness fix.**
 * Two of these checks used to throw from module bodies that hooks.server.ts imported for their
 * side effect alone. Source order there was `rateLimit` then `crypto`; the published image threw
 * TOTP_ENCRYPTION_KEY first. The evaluation order was a property of the production chunk graph,
 * not of the source, so the sequence an operator walks could change on any dependency or build
 * change — and no test would notice, because each individual message is still correct. Collecting
 * removes the ordering question rather than pinning it.
 *
 * Every message below belongs to the module that owns the variable and is reused verbatim rather
 * than restated here: a copy would be a second source, and the two would drift.
 * `assertBootstrapTokenConfigured` is the shape the others were brought up to — what, why, the
 * format, and a command that generates a valid value.
 *
 * Ordering here is presentation only. The list is walked to the end whatever happens, so no
 * failure can hide another, which is precisely the property the module-level throws lacked.
 */
export async function assertEnvironmentConfigured(): Promise<void> {
	const problems = await collectEnvironmentProblems(ENVIRONMENT_CHECKS);
	if (problems.length === 0) return;

	throw new Error(buildEnvironmentReport(problems));
}

/**
 * Exported so each bound's own spec can assert its check is reached at boot by comparing the
 * FUNCTION REFERENCE, rather than by grepping hooks.server.ts for its name. Those specs used to
 * scan the source text, which was honest about being a proxy and calibrated as one; an identity
 * comparison is not a proxy at all, and it does not break when the wiring moves file.
 */
export const ENVIRONMENT_CHECKS: Check[] = [
	['DATABASE_URL / DATABASE_PROVIDER', assertDatabaseConfigured],
	['TOTP_ENCRYPTION_KEY', assertEncryptionKeyConfigured],
	['RATE_LIMIT_HASH_SECRET', assertRateLimitSecretConfigured],
	['BOOTSTRAP_TOKEN', assertBootstrapTokenConfigured],
	['ADDRESS_HEADER / XFF_DEPTH', assertForwardingConfigSafe],
	['IMPORT_XLSX_MAX_UNCOMPRESSED_MB', assertXlsxBoundConfigured],
	['BACKUP_MAX_JSON_NODES', assertBackupBoundConfigured],
	['CSV_MAX_COLUMNS', assertCsvColumnBoundConfigured],
	['COLUMN_MAPPINGS_PER_USER', assertColumnMappingCapConfigured]
];

/**
 * The report an operator actually reads, separated from the checks so its shape can be asserted
 * without configuring anything.
 *
 * The closing paragraph names WHERE the values go, because every message above names a variable
 * and none of them says which file it belongs in — which is a thing you only know if you already
 * knew it.
 */
export function buildEnvironmentReport(problems: string[]): string {
	const heading =
		problems.length === 1
			? 'BudgetPilot cannot start: one configuration problem.'
			: `BudgetPilot cannot start: ${problems.length} configuration problems, all of them listed below rather than one per restart.`;

	return (
		`${heading}\n\n` +
		problems.map((problem, index) => `  ${index + 1}. ${problem}`).join('\n\n') +
		'\n\nAll of these go in the same place: the .env file next to docker-compose.yml. ' +
		'`npm run setup` writes the three secrets for you. Restart after editing.'
	);
}
