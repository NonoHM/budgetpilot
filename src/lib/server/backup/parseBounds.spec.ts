import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	assertBackupBoundConfigured,
	BACKUP_DEFAULT_MAX_JSON_NODES,
	BACKUP_MAX_JSON_NODES_CEILING,
	BACKUP_MAX_JSON_NODES_ENV,
	countJsonNodes,
	LARGEST_EXPORTABLE_JSON_NODES,
	resolveBackupMaxJsonNodes
} from './parseBounds';

/**
 * The structural bound on a restored backup (#276, ASVS 5.0 `v5.2.3` in spirit: bound the resource
 * before consuming it).
 *
 * THE ONE QUESTION THIS FILE HAS TO ANSWER, because every other assertion here is satisfied without
 * it: **can this bound tell a legitimate backup from a bomb of the same size?** A bound that
 * refused both would pass every refusal test below, and lowering the byte cap (the fix the issue
 * proposes) refuses both by construction. So the load-bearing test is the PAIR: two payloads at the
 * same byte count, one admitted and one refused, with the figures asserted absolutely.
 *
 * Measured, and it is why the byte cap is not what moved:
 *
 *   legitimate, 40,559 transactions   19,984,661 B    714,505 values   28.0 B/value   132 MB   97 ms
 *   `[{},{},...]`                     19,999,993 B 13,333,329 values    1.5 B/value   801 MB  830 ms
 *
 * WHAT WOULD MAKE THE REFUSALS GREEN WITHOUT THE BOUND WORKING: the byte cap refusing first; the
 * schema refusing after the parse (which is exactly the defect, since the cost is already paid); the
 * counter returning something huge for every input; or the fixture not actually being at the size it
 * claims. Each is closed by a positive control asserted before the refusal.
 *
 * BREAK-CHECK, reproducing the figure rather than merely going red. With the bound removed, a
 * 20 MB `[{},{},...]` payload parses and costs **801 MB of RSS in 830 ms**, matching what #276
 * recorded. With it in place the same payload is refused after a 28.5 ms scan, having allocated
 * nothing beyond the text already in memory.
 */

/** The pathological shape: `{},` is three bytes and contributes two countable values. */
function bombText(bytes: number): string {
	return '[' + '{},'.repeat(Math.floor(bytes / 3) - 2) + '{}]';
}

/**
 * A legitimate export's shape at the density the real exporter produces. Not the real 20 MB fixture,
 * which would make this suite slow; the density is what matters and it is asserted below.
 */
function realisticExport(transactions: number): string {
	const rows = Array.from({ length: transactions }, (_, i) => ({
		id: `cmsqeu119${String(i).padStart(11, '0')}xk`,
		accountId: 'cmsqeu10k00afw8klhoez9xgy',
		categoryId: 'cmsqepi0t005nw8klavrj2j9w',
		importBatchId: null,
		date: '2026-03-12T00:00:00.000Z',
		label: `CARTE 12/03 CARREFOUR MARKET ${String(i).padStart(6, '0')} FACTURE 4512`,
		amountCents: -((i % 9000) + 100),
		type: 'expense',
		source: 'manual',
		notes: null,
		bankOperationType: null,
		manualCategory: null,
		natureManual: null,
		dedupeKey: `a3f9${String(i).padStart(8, '0')}c71e5b2d4408f6a9b3c1d7e2`,
		metadataJson: null
	}));
	return JSON.stringify({ formatVersion: 1, exportedAt: '2026-08-13', transactions: rows });
}

function withEnv<T>(value: string | undefined, run: () => T): T {
	const previous = process.env[BACKUP_MAX_JSON_NODES_ENV];
	if (value === undefined) delete process.env[BACKUP_MAX_JSON_NODES_ENV];
	else process.env[BACKUP_MAX_JSON_NODES_ENV] = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env[BACKUP_MAX_JSON_NODES_ENV];
		else process.env[BACKUP_MAX_JSON_NODES_ENV] = previous;
	}
}

function captureWarnings(run: () => void): string[] {
	const lines: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	try {
		run();
	} finally {
		console.warn = original;
	}
	return lines;
}

describe('the counter measures density, which is what separates the two payloads', () => {
	it('counts a real export at about 28 bytes per value, and the bomb at 1.5', () => {
		expect.assertions(4);

		const legitimate = realisticExport(5_000);
		const legitimateNodes = countJsonNodes(legitimate);
		const density = legitimate.length / legitimateNodes;

		// Absolute figures. A counter that returned 1 for everything, or the byte length for
		// everything, would satisfy every refusal in this file and neither would satisfy these.
		expect(legitimateNodes).toBeGreaterThan(50_000);
		expect(density).toBeGreaterThan(20);

		const bomb = bombText(legitimate.length);
		const bombDensity = bomb.length / countJsonNodes(bomb);
		expect(bombDensity).toBeLessThan(2);
		// The whole claim of this fix in one assertion: at the SAME byte count the two differ by an
		// order of magnitude. If this ratio ever collapses, the bound has stopped discriminating and
		// no amount of tuning the number will help.
		expect(density / bombDensity).toBeGreaterThan(10);
	});

	it('over-counts rather than under-counts when a string contains a separator', () => {
		expect.assertions(2);

		// The scan is not string-aware, deliberately: a string-aware scanner is a second parser
		// written by hand on the one path where an attacker chooses the input. Counting a comma
		// inside a label is the safe direction, and this pins WHICH direction it errs in.
		const withComma = JSON.stringify({ label: 'CARREFOUR, PARIS' });
		const withoutComma = JSON.stringify({ label: 'CARREFOUR  PARIS' });
		expect(countJsonNodes(withComma)).toBeGreaterThan(countJsonNodes(withoutComma));
		expect(countJsonNodes(withoutComma)).toBe(2);
	});
});

describe('v5.2.3: the bound admits a real backup and refuses a bomb of the same size', () => {
	it('THE PAIR: same byte count, opposite verdicts', () => {
		expect.assertions(5);

		// 40,559 transactions is what the 20 MB byte cap admits, measured. Scaled down here so the
		// suite stays fast; the density, which is the property, is identical.
		const legitimate = realisticExport(20_000);
		const bomb = bombText(legitimate.length);

		// The control that closes "the byte cap refused it first": both are the same size, so the
		// byte cap cannot be what distinguishes them.
		expect(Math.abs(bomb.length - legitimate.length)).toBeLessThan(10);

		const legitimateNodes = countJsonNodes(legitimate);
		const bombNodes = countJsonNodes(bomb);
		expect(legitimateNodes).toBeLessThan(BACKUP_DEFAULT_MAX_JSON_NODES);
		expect(bombNodes).toBeGreaterThan(BACKUP_DEFAULT_MAX_JSON_NODES);
		// And it parses, so "admitted" means admitted rather than refused later for another reason.
		expect(() => JSON.parse(legitimate)).not.toThrow();
		expect(JSON.parse(legitimate).transactions).toHaveLength(20_000);
	});

	it('the default clears what this application can itself export, with headroom', () => {
		expect.assertions(3);

		// THE FLOOR THAT MATTERS. The app must be able to restore anything it can export, so the
		// bound is compared against the arithmetic ceiling of an export rather than against a
		// realistic one. 888,888 is 20,000,000 bytes at 22.5 bytes per value, which is a category
		// record carrying a 25-character cuid and a one-character name: the densest thing the
		// exporter can emit.
		expect(LARGEST_EXPORTABLE_JSON_NODES).toBeLessThan(BACKUP_DEFAULT_MAX_JSON_NODES);
		expect(BACKUP_DEFAULT_MAX_JSON_NODES / LARGEST_EXPORTABLE_JSON_NODES).toBeGreaterThan(2);
		// A measured full-size export, for the second figure the headroom is quoted against.
		expect(BACKUP_DEFAULT_MAX_JSON_NODES / 714_505).toBeGreaterThan(2.5);
	});

	it('a payload of one enormous string is NOT what this bounds, and that is deliberate', () => {
		expect.assertions(2);

		// Stated as a test rather than a comment so it is not read as an oversight. One value, so the
		// structural bound is silent; measured at 20 MB of memory and 8 ms, which is cheap, and the
		// byte cap is what bounds it. The two bounds are complementary rather than overlapping.
		const oneString = '"' + 'a'.repeat(100_000) + '"';
		expect(countJsonNodes(oneString)).toBe(1);
		expect(countJsonNodes(oneString)).toBeLessThan(BACKUP_DEFAULT_MAX_JSON_NODES);
	});
});

describe('the bound is configurable, and the configuration cannot remove it', () => {
	it('is OPTIONAL: an absent or blank value is the default, never a refusal to start', () => {
		expect.assertions(4);

		// Unlike TOTP_ENCRYPTION_KEY and BOOTSTRAP_TOKEN, which guard secrets with no safe default.
		expect(() => withEnv(undefined, assertBackupBoundConfigured)).not.toThrow();
		expect(() => withEnv('', assertBackupBoundConfigured)).not.toThrow();
		expect(withEnv(undefined, resolveBackupMaxJsonNodes)).toBe(BACKUP_DEFAULT_MAX_JSON_NODES);
		expect(withEnv('   ', resolveBackupMaxJsonNodes)).toBe(BACKUP_DEFAULT_MAX_JSON_NODES);
	});

	it('honours a legal value, which is what makes every refusal below mean something', () => {
		expect.assertions(2);

		expect(withEnv('3000000', resolveBackupMaxJsonNodes)).toBe(3_000_000);
		expect(withEnv(String(BACKUP_MAX_JSON_NODES_CEILING), resolveBackupMaxJsonNodes)).toBe(
			BACKUP_MAX_JSON_NODES_CEILING
		);
	});

	it('refuses a value above the hard ceiling instead of clamping it', () => {
		expect.assertions(3);

		// Asserted on the THROW rather than on the returned number, precisely because a clamp
		// returns a perfectly reasonable number. PASSWORD_HASH_COST clamps this way today (#284).
		expect(() => withEnv('4000001', resolveBackupMaxJsonNodes)).toThrow(/hard ceiling/);
		expect(() => withEnv('99999999', resolveBackupMaxJsonNodes)).toThrow(
			new RegExp(BACKUP_MAX_JSON_NODES_ENV)
		);
		expect(() => withEnv('99999999', assertBackupBoundConfigured)).toThrow(/hard ceiling/);
	});

	it('refuses a malformed value rather than falling back to the default', () => {
		expect.assertions(4);

		for (const bad of ['0', '-1', 'beaucoup', '2e6.5']) {
			expect(() => withEnv(bad, resolveBackupMaxJsonNodes)).toThrow(/whole number/);
		}
	});

	it('says nothing at boot on the default, and names both values on any departure', () => {
		expect.assertions(4);

		// Presence control first: a logger that warned unconditionally would satisfy the rest, and an
		// operator who sees a warning on a default install stops reading warnings.
		expect(withEnv(undefined, () => captureWarnings(assertBackupBoundConfigured))).toEqual([]);

		const raised = withEnv('3500000', () => captureWarnings(assertBackupBoundConfigured));
		expect(raised.join('\n')).toContain('=3500000');
		expect(raised.join('\n')).toContain(`default of ${BACKUP_DEFAULT_MAX_JSON_NODES}`);
		expect(raised.join('\n')).toContain('RAISED');
	});

	it('warns when the bound is set below what this application can export', () => {
		expect.assertions(2);

		// The direction that matters more here than for the xlsx bound: below this figure the app
		// refuses to restore files it wrote itself, and the user is told the backup is corrupted.
		const lowered = withEnv('500000', () => captureWarnings(assertBackupBoundConfigured));
		expect(lowered.join('\n')).toContain('LOWERED');
		expect(lowered.join('\n')).toContain(String(LARGEST_EXPORTABLE_JSON_NODES));
	});

	it('the boot check is wired into the init hook, and the bound into the restore action', () => {
		expect.assertions(6);

		// WITHOUT THIS THE CEILING IS DECORATION, and the bound with it. Every other test here calls
		// the module directly, so all of them pass on a build where nothing invokes it.
		//
		// The boot wiring is now two links — init calls the boot collector, the collector calls
		// this — so both are asserted. A source scan rather than an import of the collector, which
		// would pull in the Prisma client through bootstrapToken for a fact that is textual.
		const hooks = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
		const collector = readFileSync(new URL('../env/assertConfigured.ts', import.meta.url), 'utf8');
		const settings = readFileSync(
			new URL('../../../routes/settings/+page.server.ts', import.meta.url),
			'utf8'
		);
		const calls = (source: string, name: string) => new RegExp(`\\b${name}\\b`).test(source);

		expect(calls(collector, 'assertBackupBoundConfigured')).toBe(true);
		expect(/await assertEnvironmentConfigured\(\)/.test(hooks)).toBe(true);
		expect(calls(settings, 'countJsonNodes')).toBe(true);
		// The ORDER is the fix, not the presence: after `JSON.parse` the bound guards nothing,
		// which is the entire defect #276 describes.
		expect(settings.indexOf('countJsonNodes(rawText)')).toBeLessThan(
			settings.indexOf('JSON.parse(rawText)')
		);
		// Calibration, both halves: the same predicate must report false on a source that does not
		// name the thing.
		expect(calls('export const CHECKS = [somethingElse];', 'assertBackupBoundConfigured')).toBe(
			false
		);
		expect(/await assertEnvironmentConfigured\(\)/.test('export const init = async () => {};')).toBe(
			false
		);
	});
});
