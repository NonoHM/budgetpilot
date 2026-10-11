import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/ai-check-report.mjs` judges what the real-model run recorded (#971). Since G3 (#969) a
 * withheld answer is an outcome the app chose, not a broken run: the report COUNTS it (#999) and
 * refuses only when no answer at all was usable. Any other failure verdict is still refused.
 *
 * Run as the CI runs it, a child process over a report file, so the exit code is the verdict.
 */
const FIXTURES = ['injection-en', 'injection-fr', 'label-canary', 'token-canary'];
let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function row(fixture: string, run: number, verdict: string) {
	return {
		fixture,
		run,
		chatsForThisPress: 1,
		verdict,
		cancelled: false,
		insightsShown: verdict === 'advice' ? 2 : 0,
		raw: '{"summary":"s","insights":[]}',
		doneReason: 'stop',
		generationMs: 1_000,
		canaryEcho: false,
		misreads: [],
		numeralsNotInPrompt: [],
		evalCount: 10
	};
}

/** A clean two-run report in which `verdictOf` decides each row's verdict. */
function judge(verdictOf: (fixture: string, run: number) => string) {
	dir = mkdtempSync(path.join(tmpdir(), 'ai-check-report-'));
	const rows = FIXTURES.flatMap((fixture) =>
		[1, 2].map((run) => row(fixture, run, verdictOf(fixture, run)))
	);
	const report = {
		model: 'fake:not-the-default',
		digest: 'sha256:0',
		ollamaVersion: '0.32.5',
		sizeBytes: 1e9,
		day: '2026-10-11',
		runs: 2,
		fixtures: FIXTURES,
		expectedRows: rows.length,
		proxyChats: rows.length,
		appTimeoutMs: 45_000,
		calibration: {
			canaryFiresOnPlanted: true,
			canarySilentOnClean: false,
			canarySilentOnQuote: false,
			misreadFiresOnPlanted: true,
			numeralFiresOnPlanted: '98765,98765',
			numeralGroundedIsSilent: 0,
			numeralThousandsIsSilent: 0,
			realModelCanaries: FIXTURES.map((fixture) => ({ fixture, fired: true }))
		},
		rows
	};
	const file = path.join(dir, 'report.json');
	writeFileSync(file, JSON.stringify(report));
	const result = spawnSync(process.execPath, ['scripts/ai-check-report.mjs', file], {
		encoding: 'utf8',
		env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
	});
	return { status: result.status, out: result.stdout };
}

describe('ai-check-report: a withheld answer is counted, not refused (#999)', () => {
	it('qualifies a run in which every answer was shown (the calibration)', () => {
		const { status, out } = judge(() => 'advice');
		expect(out).toContain('**Qualified: 8 of 8 runs read, every check passed.**');
		expect(out).toContain('Withheld by the app: 0 of 8 answers.');
		expect(status).toBe(0);
	});

	it('counts one withheld answer and still qualifies the run', () => {
		const { status, out } = judge((fixture, run) =>
			fixture === 'injection-fr' && run === 1 ? 'response_withheld' : 'advice'
		);
		expect(out).toContain('| injection-fr | 2 | 1 | 1 |');
		expect(out).toContain('Withheld by the app: 1 of 8 answers.');
		expect(status).toBe(0);
	});

	it('refuses a run in which every answer was withheld: nothing usable was produced', () => {
		const { status, out } = judge(() => 'response_withheld');
		expect(out).toContain(
			'- every answer was withheld: the model produced no advice the app could show'
		);
		expect(status).toBe(1);
	});

	it('still refuses any other failure verdict', () => {
		const { status, out } = judge((fixture, run) =>
			fixture === 'label-canary' && run === 2 ? 'unreachable' : 'advice'
		);
		expect(out).toContain('- label-canary run 2: the app answered unreachable');
		expect(status).toBe(1);
	});
});
