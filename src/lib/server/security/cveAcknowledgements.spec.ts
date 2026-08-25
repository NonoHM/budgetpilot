import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, parseAcknowledgements } from '../../../../scripts/cve-acknowledgements.mjs';

/**
 * The filter that decides whether a scheduled-scan finding gets a fresh tracker issue.
 *
 * WHY THIS FILE IS THE POINT OF THE CHANGE, not a check on it. `.trivyignore` is disabled at all
 * three gate steps (`TRIVY_IGNOREFILE=/dev/null`) precisely so a repo file cannot decide whether
 * the alarm sounds. This mechanism is a repo file deciding whether the alarm gets a tracker entry,
 * which is a smaller claim but the same shape — and its failure mode is SILENCE. A suppression
 * that stops working announces nothing; it just stops filing, and every morning that follows looks
 * exactly like a morning with no findings.
 *
 * So the calibration is not "does the filter suppress". It is the pair: **which two states does
 * this separate, and can it actually separate them.** Every test below names its pair.
 *
 * The module is plain `.mjs` rather than `.ts` on purpose: the workflow runs it with bare `node`
 * on a runner that has no `setup-node` step and no build, so it cannot depend on type stripping.
 */

/** Trivy's JSON shape, reduced to the two fields the filter reads. */
function report(...ids: string[]): string {
	return JSON.stringify({
		Results: [
			{
				Target: 'ghcr.io/nonohm/budgetpilot:latest (debian 13.1)',
				Vulnerabilities: ids.map((id) => ({
					VulnerabilityID: id,
					PkgName: 'libssl3t64',
					InstalledVersion: '3.5.6-1~deb13u2',
					Severity: 'HIGH'
				}))
			}
		]
	});
}

const ACK_FILE = ['# comment line, ignored', '', 'CVE-2026-14456\t2026-11-24\t#385'].join('\n');

describe('decide', () => {
	it('files when a finding carries no acknowledgement', () => {
		// separates "an untriaged finding" from "a triaged one": only the second may be silent.
		const result = decide({
			reportTexts: [report('CVE-2026-99999')],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.file).toBe(true);
		expect(result.unacknowledged).toEqual(['CVE-2026-99999']);
	});

	it('stays silent when every finding is acknowledged and the acknowledgement is live', () => {
		// separates "the filter suppressed" from "the filter never ran": the assertion is on the
		// acknowledged list too, so a filter that read nothing cannot pass this.
		const result = decide({
			reportTexts: [report('CVE-2026-14456')],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.file).toBe(false);
		expect(result.unacknowledged).toEqual([]);
		expect(result.acknowledged.map((a) => a.id)).toEqual(['CVE-2026-14456']);
	});

	it('files again once the acknowledgement has expired', () => {
		// THE anti-permanent-silence property. Separates "bounded silence" from "suppression".
		const result = decide({
			reportTexts: [report('CVE-2026-14456')],
			acknowledgementsText: ACK_FILE,
			today: '2026-11-25'
		});

		expect(result.file).toBe(true);
		expect(result.unacknowledged).toEqual(['CVE-2026-14456']);
	});

	it('treats the expiry date itself as the last live day', () => {
		// The boundary is the single value where "expired" and "live" disagree: 2026-11-24.
		// Tested ON it, plus the day either side, because an off-by-one here is a day of
		// silence that no other test can see.
		const on = decide({
			reportTexts: [report('CVE-2026-14456')],
			acknowledgementsText: ACK_FILE,
			today: '2026-11-24'
		});
		const after = decide({
			reportTexts: [report('CVE-2026-14456')],
			acknowledgementsText: ACK_FILE,
			today: '2026-11-25'
		});

		expect(on.file).toBe(false);
		expect(after.file).toBe(true);
	});

	it('files when a new id appears beside an acknowledged one, and names only the new id', () => {
		// separates "this exact finding was ruled on" from "findings in this package were ruled
		// on". An acknowledgement covers an id, never a package or a pattern.
		const result = decide({
			reportTexts: [report('CVE-2026-14456', 'CVE-2027-00001')],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.file).toBe(true);
		expect(result.unacknowledged).toEqual(['CVE-2027-00001']);
	});

	it('unions the findings across platforms rather than reading only the first report', () => {
		// separates "both platforms considered" from "amd64 considered": an arm64-only finding
		// is exactly what a single-report read would silently drop.
		const result = decide({
			reportTexts: [report('CVE-2026-14456'), report('CVE-2026-14456', 'CVE-2027-00002')],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.file).toBe(true);
		expect(result.unacknowledged).toEqual(['CVE-2027-00002']);
	});
});

describe('parseAcknowledgements', () => {
	it('reads id, expiry and ruling, ignoring comments and blank lines', () => {
		const acks = parseAcknowledgements(ACK_FILE);

		expect(acks).toEqual([{ id: 'CVE-2026-14456', expires: '2026-11-24', ruling: '#385' }]);
	});
});

describe('the guards that stop a suppression failing silent', () => {
	// Every case below fails OPEN: the finding still reaches the tracker. A filter that cannot
	// decide must never be the reason nothing is filed, because "decided everything is fine" and
	// "could not read anything" produce the identical empty output otherwise.

	it('cannot decide when a report is missing, and files rather than staying silent', () => {
		// separates "no findings" from "no report". The gate only invokes this after it failed,
		// so an absent report is scanner infrastructure, not an all-clear.
		const result = decide({
			reportTexts: [null],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.cannotDecide).toBe(true);
		expect(result.file).toBe(true);
	});

	it('cannot decide when a report is not valid JSON', () => {
		const result = decide({
			reportTexts: ['{ this is not json'],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.cannotDecide).toBe(true);
		expect(result.file).toBe(true);
	});

	it('cannot decide when a report parses but carries no Results array', () => {
		// The shape changing under us reads exactly like a clean scan otherwise.
		const result = decide({
			reportTexts: ['{"SchemaVersion":2}'],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.cannotDecide).toBe(true);
		expect(result.file).toBe(true);
	});

	it('cannot decide when the reports parse but yield zero findings', () => {
		// THE confident zero. This function runs only because a CRITICAL/HIGH gate failed, so
		// "no findings extracted" means the extraction is wrong, not that the image is clean.
		const result = decide({
			reportTexts: [report()],
			acknowledgementsText: ACK_FILE,
			today: '2026-08-25'
		});

		expect(result.cannotDecide).toBe(true);
		expect(result.file).toBe(true);
	});

	it('refuses an acknowledgement line that is missing its ruling', () => {
		// The ruling is what makes an entry auditable. Without it the file records a silence
		// with no argument attached, which is what .trivyignore exists to not be.
		expect(() => parseAcknowledgements('CVE-2026-14456\t2026-11-24')).toThrow(/ruling/i);
	});

	it('refuses a wildcard or pattern where an id belongs', () => {
		// separates "this finding was ruled on" from "findings like this one were". A pattern
		// would let one entry silence a CVE nobody has ever read.
		expect(() => parseAcknowledgements('*\t2026-11-24\t#385')).toThrow(/CVE-/);
		expect(() => parseAcknowledgements('CVE-2026-*\t2026-11-24\t#385')).toThrow(/CVE-/);
	});

	it('refuses an expiry that is not a real calendar date', () => {
		expect(() => parseAcknowledgements('CVE-2026-14456\t2026-02-30\t#385')).toThrow(/date/i);
		expect(() => parseAcknowledgements('CVE-2026-14456\tsoon\t#385')).toThrow(/date/i);
	});

	it('refuses an acknowledgement with no expiry at all', () => {
		// An entry with no expiry is a permanent silence, which is the thing being avoided.
		expect(() => parseAcknowledgements('CVE-2026-14456')).toThrow();
	});

	it('refuses the same id twice, because which expiry wins would be a coin toss', () => {
		const twice = ['CVE-2026-14456\t2026-11-24\t#385', 'CVE-2026-14456\t2027-11-24\t#385'].join(
			'\n'
		);

		expect(() => parseAcknowledgements(twice)).toThrow(/twice|duplicate/i);
	});

	it('names the offending line number, so a bad entry is findable', () => {
		const text = ['# header', 'CVE-2026-14456\t2026-11-24\t#385', 'nonsense'].join('\n');

		expect(() => parseAcknowledgements(text)).toThrow(/line 3/);
	});
});

describe('the clock is an input, so it is validated like one', () => {
	it('refuses a today that is not a real calendar date', () => {
		// THE SUBTLE TOTAL SILENCE. Expiry is a string comparison, so an empty or malformed
		// `today` makes `expires >= today` true for EVERY entry at once: the whole file goes
		// live and nothing is ever filed again. Nothing else in this suite can see that,
		// because each individual entry still looks correct.
		for (const today of ['', 'today', '2026-8-25', '2026-02-30']) {
			expect(() =>
				decide({
					reportTexts: [report('CVE-2026-14456')],
					acknowledgementsText: ACK_FILE,
					today
				})
			).toThrow(/date/i);
		}
	});
});

describe('the checked-in acknowledgement file', () => {
	it('parses, so a malformed entry reddens here rather than at 06:17 UTC', () => {
		// Deliberately NOT asserting that entries are unexpired: that would be a time bomb that
		// reddens CI for everybody on a date, and blocks unrelated work. An expiry passing is
		// supposed to make the SCAN file an issue again, which is the mechanism working. This
		// asserts only that the file can be read at all.
		const text = readFileSync(new URL('../../../../.cve-acknowledged', import.meta.url), 'utf8');

		const acks = parseAcknowledgements(text);

		expect(acks.length).toBeGreaterThan(0);
		for (const ack of acks) {
			expect(ack.id).toMatch(/^CVE-\d{4}-\d{4,}$/);
			expect(ack.ruling).not.toBe('');
		}
	});
});

describe('the command line the workflow actually runs', () => {
	// The workflow skips filing on exactly one signal: exit 0 with empty stdout. Everything
	// else files. These tests pin that contract from the outside, because the wiring in YAML
	// cannot be unit tested and a mistake there is invisible until a morning with no issue.

	const CLI = fileURLToPath(
		new URL('../../../../scripts/cve-acknowledgements.mjs', import.meta.url)
	);

	/** Runs the CLI, returning status and streams rather than throwing on a non-zero exit. */
	function run(args: string[]) {
		const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
		return {
			status: result.status,
			stdout: result.stdout.trim(),
			stderr: result.stderr.trim()
		};
	}

	function fixture(name: string, contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'cve-ack-'));
		const file = join(dir, name);
		writeFileSync(file, contents);
		return file;
	}

	const ack = () => fixture('.cve-acknowledged', 'CVE-2026-14456\t2999-01-01\t#385');

	it('exits 0 with empty stdout when every finding is acknowledged — the only skip signal', () => {
		// THIS TEST WENT GREEN AGAINST A MODULE WITH NO CLI AT ALL, which is why it asserts
		// stderr too. A file that prints nothing and exits 0 satisfies "status 0, stdout empty"
		// trivially, so the skip signal on its own cannot separate "decided everything is
		// acknowledged" from "never ran". The reason line on stderr is what makes it a decision.
		const result = run([ack(), fixture('r.json', report('CVE-2026-14456'))]);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toMatch(/live acknowledgement/i);
		expect(result.stderr).toContain('CVE-2026-14456');
	});

	it('exits 0 and names the ids on stdout when something is unacknowledged', () => {
		const result = run([ack(), fixture('r.json', report('CVE-2027-00001'))]);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('CVE-2027-00001');
	});

	it('exits non-zero when a report is missing, so the workflow files rather than skips', () => {
		// The trap this closes: cannotDecide means file, but carries no ids, so it would reach
		// stdout as empty — indistinguishable from the skip signal above if the exit code did
		// not separate them.
		const result = run([ack(), join(tmpdir(), 'no-such-report-cve-ack.json')]);

		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
	});

	it('exits non-zero when the acknowledgement file is malformed', () => {
		const result = run([
			fixture('.cve-acknowledged', 'nonsense'),
			fixture('r.json', report('CVE-1'))
		]);

		expect(result.status).not.toBe(0);
	});

	it('runs when invoked through a symlinked path', () => {
		// FOUND BY THE WIRING CALIBRATION, NOT BY THIS SUITE, and the failure was silent: a
		// main-module check comparing import.meta.url (which is the realpath) against
		// process.argv[1] (which is not symlink-resolved) simply never enters the CLI block.
		// Node then exits 0 having printed nothing — which is byte-identical to the skip signal,
		// so every finding would have been silently dropped.
		const dir = mkdtempSync(join(tmpdir(), 'cve-ack-link-'));
		const link = join(dir, 'cve-acknowledgements.mjs');
		symlinkSync(CLI, link);

		const result = spawnSync(
			process.execPath,
			[link, ack(), fixture('r.json', report('CVE-2027-00001'))],
			{
				encoding: 'utf8'
			}
		);

		expect(result.stdout.trim()).toBe('CVE-2027-00001');
		expect(result.status).toBe(0);
	});

	it('exits non-zero when no report arguments are given at all', () => {
		// A wiring mistake that passes no reports must not read as "nothing to file".
		const result = run([ack()]);

		expect(result.status).not.toBe(0);
	});
});

describe('trivy-report.sh, the renderer the same step depends on', () => {
	const RENDERER = fileURLToPath(new URL('../../../../scripts/trivy-report.sh', import.meta.url));

	it('renders an unparseable report as an infrastructure note instead of dying', () => {
		// FOUND BY THE WIRING CALIBRATION. It already handles a MISSING report, and jq dies on a
		// malformed one — which under `set -e` kills the whole step before `gh` is reached, so a
		// scan that found CRITICAL/HIGH files NOTHING. The silence is total and looks like a
		// clean morning. Separates "could not render" from "nothing to render".
		const dir = mkdtempSync(join(tmpdir(), 'cve-render-'));
		const broken = join(dir, 'trivy-report-amd64.json');
		writeFileSync(broken, '{ not json at all');

		const result = spawnSync('bash', [RENDERER, broken, 'amd64'], { encoding: 'utf8' });

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/infrastructure/i);
	});

	it('still renders a good report as a findings table', () => {
		// The calibration for the case above: proves this harness can see a real render, so the
		// note above is a behaviour rather than a script that always prints the same thing.
		const dir = mkdtempSync(join(tmpdir(), 'cve-render-ok-'));
		const good = join(dir, 'trivy-report-amd64.json');
		writeFileSync(good, report('CVE-2026-14456'));

		const result = spawnSync('bash', [RENDERER, good, 'amd64'], { encoding: 'utf8' });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('CVE-2026-14456');
		expect(result.stdout).toContain('| Severity | Package |');
	});
});

describe('the workflow wiring itself', () => {
	/**
	 * These run the ACTUAL shell out of .github/workflows/trivy-scheduled.yml, extracted from the
	 * YAML rather than retyped, with `gh` stubbed. Retyping it would be the copied-predicate
	 * failure: the test and the thing under test would share a source and agree by construction.
	 *
	 * This layer exists because it has already earned its place twice. It found a main-module
	 * check that silently dropped every finding when invoked through a symlink, and a malformed
	 * report that killed the step before `gh` was reached — neither visible to the unit tests
	 * above, both of which failed by filing NOTHING, which is the failure this whole change is
	 * about.
	 */
	const WORKFLOW = fileURLToPath(
		new URL('../../../../.github/workflows/trivy-scheduled.yml', import.meta.url)
	);
	const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

	/** The `run:` block of one named step, dedented, straight out of the YAML. */
	function runBlock(stepName: string): string {
		const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
		const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
		expect(start, `step ${stepName} not found in the workflow`).toBeGreaterThanOrEqual(0);
		const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
		expect(runAt, `step ${stepName} has no run block`).toBeGreaterThan(start);

		const bodyIndent = lines[runAt].length - lines[runAt].trimStart().length + 2;
		const body: string[] = [];
		for (const line of lines.slice(runAt + 1)) {
			if (line.trim() === '') {
				body.push('');
				continue;
			}
			if (line.length - line.trimStart().length < bodyIndent) break;
			body.push(line.slice(bodyIndent));
		}
		return body.join('\n');
	}

	/** Runs the step against fixtures; reports whether `gh` was invoked. */
	function runStep(fixtures: { ack: string; amd64: string | null; arm64: string | null }) {
		const dir = mkdtempSync(join(tmpdir(), 'cve-wiring-'));
		symlinkSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'));
		writeFileSync(join(dir, '.cve-acknowledged'), fixtures.ack);
		if (fixtures.amd64 !== null)
			writeFileSync(join(dir, 'trivy-report-amd64.json'), fixtures.amd64);
		if (fixtures.arm64 !== null)
			writeFileSync(join(dir, 'trivy-report-arm64.json'), fixtures.arm64);

		const calls = join(dir, 'gh-calls.txt');
		writeFileSync(calls, '');
		mkdirSync(join(dir, 'bin'));
		writeFileSync(
			join(dir, 'bin', 'gh'),
			`#!/usr/bin/env bash\necho "GH_CALLED $*" >> "${calls}"\nexit 0\n`,
			{ mode: 0o755 }
		);
		writeFileSync(join(dir, 'step.sh'), runBlock('Open or update the alert issue'));

		const result = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
			cwd: dir,
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
				IMAGE_REF: 'ghcr.io/nonohm/budgetpilot:latest',
				RUN_URL: 'https://example.invalid/run',
				GH_TOKEN: 'stub',
				GH_REPO: 'stub/stub'
			}
		});

		const ghCalls = readFileSync(calls, 'utf8').trim();
		return {
			filed: ghCalls !== '',
			log: `${result.stdout}${result.stderr}`
		};
	}

	const LIVE = 'CVE-2026-14456\t2999-01-01\t#385';
	const EXPIRED = 'CVE-2026-14456\t2020-01-01\t#385';
	const both = (json: string) => ({ amd64: json, arm64: json });

	it('stays silent when every finding is acknowledged and live', () => {
		const result = runStep({ ack: LIVE, ...both(report('CVE-2026-14456')) });

		expect(result.filed).toBe(false);
		expect(result.log).toMatch(/no issue is filed/i);
	});

	it('files once the acknowledgement has expired', () => {
		// The anti-permanent-silence property, proven end to end rather than at the unit.
		const result = runStep({ ack: EXPIRED, ...both(report('CVE-2026-14456')) });

		expect(result.filed).toBe(true);
	});

	it('files for a new id even when another finding is acknowledged', () => {
		const result = runStep({
			ack: LIVE,
			amd64: report('CVE-2026-14456', 'CVE-2027-00009'),
			arm64: report('CVE-2026-14456')
		});

		expect(result.filed).toBe(true);
	});

	it('files for an arm64-only finding', () => {
		const result = runStep({
			ack: LIVE,
			amd64: report('CVE-2026-14456'),
			arm64: report('CVE-2026-14456', 'CVE-2027-00007')
		});

		expect(result.filed).toBe(true);
	});

	it('files when a report is missing', () => {
		const result = runStep({ ack: LIVE, amd64: report('CVE-2026-14456'), arm64: null });

		expect(result.filed).toBe(true);
	});

	it('files when a report is malformed', () => {
		const result = runStep({ ack: LIVE, amd64: report('CVE-2026-14456'), arm64: '{ not json' });

		expect(result.filed).toBe(true);
	});

	it('files when the acknowledgement file is broken', () => {
		const result = runStep({ ack: 'nonsense', ...both(report('CVE-2026-14456')) });

		expect(result.filed).toBe(true);
	});

	it('files when the reports parse but carry no findings at all', () => {
		const result = runStep({ ack: LIVE, ...both('{"Results":[]}') });

		expect(result.filed).toBe(true);
	});

	it('names the acknowledged finding in the body when it files for another one', () => {
		// So a filed issue is never read as the complete picture.
		const result = runStep({
			ack: LIVE,
			amd64: report('CVE-2026-14456', 'CVE-2027-00009'),
			arm64: report('CVE-2026-14456')
		});

		expect(result.filed).toBe(true);
		expect(result.log).toContain('CVE-2026-14456 acknowledged until 2999-01-01 (#385)');
	});
});
