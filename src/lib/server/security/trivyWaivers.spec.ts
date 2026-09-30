import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `.trivy-waivers.yaml` is the one repo file that can let a gate pass a fixable CRITICAL/HIGH
 * finding (#788). Trivy honours whatever it holds, so the rules that make it a time-boxed risk
 * acceptance rather than a suppression live here: every entry expires, within 14 days of its
 * grant, and cites the ruling; and only the three gate steps read the file, never the daily scan
 * whose alert must keep sounding.
 *
 * Trivy is the only consumer of the file, so there is no production parser to call. The reader
 * below accepts exactly the shape the file uses and THROWS on any other line, so a reformatted
 * entry fails loudly instead of being skipped.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(root + path, 'utf8');

const MAX_DAYS = 14;
const DAY_MS = 86_400_000;

interface Waiver {
	id: string;
	statement: string;
	expiredAt: string;
}

function parseWaivers(text: string): Waiver[] {
	const lines = text.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
	if (lines[0] !== 'vulnerabilities:') throw new Error(`unexpected first line: ${lines[0]}`);
	const waivers: Waiver[] = [];
	let current: Partial<Waiver> | null = null;
	let inStatement = false;
	for (const line of lines.slice(1)) {
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^ {2}- id: (\S+)$/))) {
			current = { id: m[1], statement: '' };
			waivers.push(current as Waiver);
			inStatement = false;
		} else if (current && /^ {4}statement: >-$/.test(line)) {
			inStatement = true;
		} else if (current && inStatement && /^ {6}\S/.test(line)) {
			current.statement = `${current.statement} ${line.trim()}`.trim();
		} else if (current && (m = line.match(/^ {4}expired_at: (\d{4}-\d{2}-\d{2})$/))) {
			current.expiredAt = m[1];
			inStatement = false;
		} else {
			throw new Error(`unexpected line in .trivy-waivers.yaml: ${line}`);
		}
	}
	return waivers;
}

/** Every reason an entry is not an acceptable waiver; empty when it is. */
function refusals(w: Waiver): string[] {
	const out: string[] = [];
	if (!/^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/.test(w.id)) out.push('id');
	if (!w.expiredAt) out.push('no expiry');
	const granted = w.statement.match(/Granted (\d{4}-\d{2}-\d{2})/)?.[1];
	if (!granted) out.push('no grant date');
	if (!/#\d+/.test(w.statement)) out.push('no ruling reference');
	if (granted && w.expiredAt) {
		const days = (Date.parse(w.expiredAt) - Date.parse(granted)) / DAY_MS;
		if (!(days > 0 && days <= MAX_DAYS)) out.push(`window ${days} days`);
	}
	return out;
}

describe('.trivy-waivers.yaml', () => {
	const waivers = parseWaivers(read('.trivy-waivers.yaml'));

	// Separates « every entry is a dated, referenced, short acceptance » from « some entry is a
	// silent or open-ended suppression ». An empty list is valid (no waiver in force), so the
	// calibration below is what proves the rules fire.
	it('holds only entries that expire within 14 days of a dated ruling', () => {
		expect(waivers.map((w) => [w.id, refusals(w)])).toEqual(waivers.map((w) => [w.id, []]));
	});

	// Calibration: each rule refuses the entry built to break it, and for that reason alone.
	it('refuses an open-ended, undated, unreferenced or wildcard entry', () => {
		const ok = {
			id: 'CVE-2026-1234',
			statement: 'Granted 2026-09-30 (#1).',
			expiredAt: '2026-10-07'
		};
		expect(refusals(ok)).toEqual([]);
		expect(refusals({ ...ok, expiredAt: '' })).toEqual(['no expiry']);
		expect(refusals({ ...ok, expiredAt: '2026-10-30' })).toEqual(['window 30 days']);
		expect(refusals({ ...ok, expiredAt: '2026-10-14' })).toEqual([]);
		expect(refusals({ ...ok, expiredAt: '2026-10-15' })).toEqual(['window 15 days']);
		expect(refusals({ ...ok, statement: 'Granted 2026-09-30.' })).toEqual(['no ruling reference']);
		expect(refusals({ ...ok, statement: 'Owner said so (#1).' })).toEqual(['no grant date']);
		expect(refusals({ ...ok, id: 'CVE-2026-*' })).toEqual(['id']);
	});

	it('refuses a line it does not know instead of skipping it', () => {
		expect(() => parseWaivers('vulnerabilities:\n  - id: CVE-2026-1\n    paths: ["x"]\n')).toThrow(
			'unexpected line'
		);
	});
});

describe('who reads the waiver file', () => {
	const count = (text: string, needle: string) => text.split(needle).length - 1;
	const ignoreFile = (f: string) =>
		[...read(f).matchAll(/TRIVY_IGNOREFILE: (\S+)/g)].map((m) => m[1]);

	// Separates « the gates accept a ruling » from « a gate can still disagree with another » and
	// from « the alert itself can be silenced ». Figures, not presence: 1 + 2 gate steps read the
	// waivers, and the daily scan's 2 gate steps still read nothing.
	it('is read by the PR gate and both release gates, and by no daily-scan step', () => {
		expect(ignoreFile('.github/workflows/ci.yml')).toEqual(['.trivy-waivers.yaml']);
		expect(ignoreFile('.github/workflows/docker-publish.yml')).toEqual([
			'.trivy-waivers.yaml',
			'.trivy-waivers.yaml'
		]);
		expect(ignoreFile('.github/workflows/trivy-scheduled.yml')).toEqual(['/dev/null', '/dev/null']);
		expect(count(read('.github/workflows/trivy-scheduled.yml'), '.trivy-waivers.yaml')).toBe(0);
	});
});
