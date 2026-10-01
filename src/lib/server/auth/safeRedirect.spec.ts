import { isRedirect, redirect } from '@sveltejs/kit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getSafeRedirect } from '$lib/server/auth';
import { BYPASS_HOST, REDIRECT_BYPASSES, REDIRECT_KEPT } from './redirectBypasses';

/**
 * The one definition every sign-in exit calls. Three kinds of check, each answering a different
 * question:
 *
 * - one test per bypass in the shared corpus: does THIS value fall back to the default;
 * - one test per legitimate shape: is the rule still usable, since `() => '/'` passes every bypass;
 * - a property over generated values, judged by two oracles that are not this repository's belief:
 *   the WHATWG URL parser (where a browser goes) and SvelteKit's own `Redirect` constructor (whether
 *   the value can be a `Location` header at all, or answers a 500 instead).
 */

const APP_ORIGIN = 'http://app.example.test';
const SEED = 20261001;
const RUNS = 20000;

describe('getSafeRedirect refuses every bypass', () => {
	for (const bypass of REDIRECT_BYPASSES) {
		it(`falls back to / for ${bypass.name}`, () => {
			expect(getSafeRedirect(bypass.value)).toBe('/');
		});
	}

	it('falls back to / when there is no value', () => {
		expect(getSafeRedirect(null)).toBe('/');
	});
});

describe('getSafeRedirect keeps what a legitimate flow produces', () => {
	for (const kept of REDIRECT_KEPT) {
		it(`keeps ${kept.name}`, () => {
			expect(getSafeRedirect(kept.value)).toBe(kept.value);
		});
	}

	it('keeps what the sign-in hook builds from a request URL', () => {
		// The producer is `hooks.server.ts`: pathname plus search of a parsed request URL, so the
		// value arrives already in the parser's canonical form, including encoded non-ASCII.
		const request = new URL(
			`${APP_ORIGIN}/transactions/caf${String.fromCharCode(0xe9)}?q=a b&tag=x`
		);
		const produced = request.pathname + request.search;
		expect(getSafeRedirect(produced)).toBe(produced);
	});
});

// Pieces chosen to reach every shape the corpus names, so the generator can assemble a bypass the
// corpus did not list. The calibration below proves it reaches the published one.
const PIECES = [
	'/',
	'//',
	'/./',
	'/../',
	'\\',
	'.',
	'..',
	'%2f',
	'%2F',
	'%5c',
	'%2e',
	'%2e%2e',
	'%',
	'%E9',
	String.fromCharCode(9),
	String.fromCharCode(10),
	String.fromCharCode(13),
	String.fromCharCode(0),
	' ',
	':',
	'@',
	'?',
	'#',
	'a',
	'https:',
	'javascript:',
	BYPASS_HOST,
	String.fromCharCode(0xe9),
	String.fromCharCode(0x2028),
	String.fromCharCode(0xff0f)
];
const candidate = fc.oneof(
	fc.array(fc.constantFrom(...PIECES), { maxLength: 8 }).map((parts) => parts.join('')),
	fc.string({ unit: 'binary', maxLength: 24 })
);

type EscapeKind =
	'rewritten' | 'unparseable' | 'off-origin' | 'empty-authority' | 'not-a-header' | 'undecodable';

interface Escape {
	readonly kind: EscapeKind;
	readonly input: string;
	readonly output: string;
	readonly why: string;
}

/** Why `output` is not a safe in-app target, or null when it is. One kind per oracle clause. */
function judge(input: string, output: string): Omit<Escape, 'input' | 'output'> | null {
	if (output !== '/' && output !== input) {
		return { kind: 'rewritten', why: 'rewrote the value instead of keeping or refusing it' };
	}
	// A throw here would fail the property with no escape recorded, which `findEscape` would read as
	// clean: the first version of this file did exactly that, and stayed green with clause 2 removed.
	const landed = URL.parse(output, APP_ORIGIN);
	if (landed === null) {
		return { kind: 'unparseable', why: 'no URL parser can follow it as a Location' };
	}
	if (landed.origin !== APP_ORIGIN) {
		return { kind: 'off-origin', why: `left the origin for ${landed.host}` };
	}
	if (landed.pathname.startsWith('//')) {
		return { kind: 'empty-authority', why: `landed on the path ${landed.pathname}` };
	}
	try {
		redirect(303, output);
	} catch (thrown) {
		if (!isRedirect(thrown)) {
			return { kind: 'not-a-header', why: 'SvelteKit refuses it as a Location header' };
		}
	}
	// SvelteKit answers 400 to a request path `decodeURI` cannot decode. This calls the same
	// primitive the rule's clause 5 calls, so it is not independent of it: the e2e journey, which
	// reads the built server's answer, is the check that is.
	try {
		decodeURI(landed.pathname);
	} catch {
		return { kind: 'undecodable', why: `SvelteKit answers 400 to the path ${landed.pathname}` };
	}
	return null;
}

/**
 * Runs the property over `rule`, returning the first escape, or the first of `only` kind when
 * given. The calibrations pass `only`, so each proves the generator reaches ITS kind rather than
 * whichever kind happens to come first.
 */
function findEscape(rule: (value: string | null) => string, only?: EscapeKind): Escape | null {
	let escape: Escape | null = null;
	// `fc.assert` throws on a failing property, and in the calibrated leg a failure is the expected
	// result, so the throw is caught in both and the finding is read off the recorded escape.
	try {
		fc.assert(
			fc.property(candidate, (input) => {
				const output = rule(input);
				const verdict = judge(input, output);
				if (verdict === null || (only !== undefined && verdict.kind !== only)) return true;
				escape ??= { ...verdict, input, output };
				return false;
			}),
			{ seed: SEED, numRuns: RUNS, endOnFailure: true }
		);
	} catch (thrown) {
		// The recorded escape is the report. A failure that recorded none is something else going
		// wrong inside the property, and reading it as a clean run is the one outcome not allowed.
		if (escape === null) throw thrown;
	}
	return escape;
}

/** The function as published up to budgetpilot-v1.2.0, kept as the calibration's known positive. */
function publishedGetSafeRedirect(value: string | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
	return value;
}

/** A rule that normalises instead of refusing, for the one clause the published function never trips. */
function normalisingRule(value: string | null): string {
	return new URL(value ?? '/', APP_ORIGIN).pathname;
}

describe('CALIBRATION: each clause of the judge finds its own kind of escape', () => {
	const cases: ReadonlyArray<[EscapeKind, (value: string | null) => string]> = [
		['off-origin', publishedGetSafeRedirect],
		['unparseable', publishedGetSafeRedirect],
		['empty-authority', publishedGetSafeRedirect],
		['not-a-header', publishedGetSafeRedirect],
		['undecodable', publishedGetSafeRedirect],
		['rewritten', normalisingRule]
	];
	for (const [kind, rule] of cases) {
		it(`finds a ${kind} escape in ${rule.name}, or that clause measures nothing`, () => {
			const escape = findEscape(rule, kind);
			console.log(
				`[redirect-calibration] kind=${kind} seed=${SEED} runs=${RUNS} escape=${JSON.stringify(escape)}`
			);
			expect(escape?.kind, `the generator must reach a ${kind} value`).toBe(kind);
		});
	}
});

describe('getSafeRedirect over generated values', () => {
	it('only ever returns the default or the unchanged value, on the origin, as a valid header', () => {
		expect(findEscape(getSafeRedirect)).toBe(null);
	});
});
