import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
	blockCommentRanges,
	isInComment,
	isInStringLiteral,
	productionSourceFiles,
	readSource,
	stringLiteralRanges
} from './sourceScan';

/**
 * Outbound request containment: check 6 of the Phase 5 automation inventory, covering
 * `v5.0.0-13.2.5` (the server may only reach an allowlist of destinations) and `v5.0.0-12.3.2`
 * (TLS clients validate certificates).
 *
 * Both are met by construction and the construction is an ABSENCE: there is no generic
 * fetch-a-URL feature, no webhook sender, no avatar-by-URL, no import-from-link, and nothing
 * disables certificate verification. The set of reachable destinations is closed because only
 * two clients exist and both route through `fetchWithRedirectGuard`, which re-validates every
 * redirect target against the same allowlist (#215).
 *
 * THE REGRESSION THIS EXISTS FOR is a THIRD outbound client added without a guard. Nothing about
 * writing one looks wrong: `await fetch(url)` in a server module is ordinary code, and the
 * allowlist it bypasses lives in a file the author never opens.
 *
 * THE SHAPE OF THE CHECK IS DECIDED BY HOW THE TWO CLIENTS ACTUALLY WORK, which is not how the
 * published evidence describes them. The automatable note said "assert `fetch(` appears in no
 * server module except the two guarded clients". Measured: **the global `fetch` is never called
 * anywhere in this application.** It is passed as a VALUE (`options.fetchImpl ?? fetch`) into
 * `fetchWithRedirectGuard`, which invokes it, and the Ollama SDK is handed a `fetch:` option that
 * routes through the same guard. A scan for `fetch(` finds zero call sites and would have been
 * green in a world where a third client had been added, because that client would most likely
 * also hand its own `fetch` to an SDK rather than calling the global directly.
 */

/**
 * The complete outbound surface: the guard, and the two clients that use it.
 *
 * A closed list, so a fourth entry is a decision. Any other server module naming `fetch` is a new
 * outbound path and this list is where its review starts.
 */
const OUTBOUND_SURFACE = [
	join('src', 'lib', 'server', 'net', 'redirectGuard.ts'),
	join('src', 'lib', 'server', 'banking', 'enablebanking', 'http.ts'),
	join('src', 'lib', 'server', 'insights', 'local-llm.ts')
];

/** HTTP clients that would reach the network without ever touching the guard. */
const ALTERNATIVE_CLIENTS =
	/from\s+['"](axios|got|node-fetch|superagent|request|undici|phin|ky)['"]|\bhttps?\.(request|get)\s*\(|\bXMLHttpRequest\b/;

/**
 * Anything that would stop Node verifying a server certificate.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED` is the process-wide switch, `rejectUnauthorized` the per-agent
 * one, and `checkServerIdentity` the hostname check an override can neuter. All three are
 * absent today, and the violation would be catastrophic and invisible: TLS would still be
 * negotiated, the padlock would still appear in any tool that draws one, and the peer would
 * simply never be authenticated.
 */
const TLS_VERIFICATION_DISABLERS = [
	/NODE_TLS_REJECT_UNAUTHORIZED/,
	/rejectUnauthorized/,
	/checkServerIdentity/
];

function serverModules(): string[] {
	return productionSourceFiles().filter((path) => {
		const p = path.split(/[\\/]/).join('/');
		return (
			p.startsWith('src/lib/server/') ||
			p.endsWith('.server.ts') ||
			p.endsWith('+server.ts') ||
			p.startsWith('src/hooks')
		);
	});
}

/** Offsets of a bare identifier, skipping comments and string literals. */
function identifierHits(source: string, identifier: RegExp): number[] {
	const comments = blockCommentRanges(source);
	const strings = stringLiteralRanges(source);
	return [...source.matchAll(identifier)]
		.map((match) => match.index)
		.filter(
			(offset) =>
				!isInComment(source, offset, comments) && !isInStringLiteral(source, offset, strings)
		);
}

describe('outbound request containment (v5.0.0-13.2.5, v5.0.0-12.3.2)', () => {
	// Every assertion below is an absence. None of them means anything until the scan is known to
	// see the outbound code that DOES exist.
	it('calibration: the scan sees the guard and both clients', () => {
		expect.assertions(2);

		const modules = serverModules();
		expect(modules.length).toBeGreaterThan(40);

		const usingGuard = modules.filter((path) => /fetchWithRedirectGuard/.test(readSource(path)));
		expect(usingGuard.sort()).toEqual([...OUTBOUND_SURFACE].sort());
	});

	it('v5.0.0-13.2.5: the global fetch is named only on the declared outbound surface', () => {
		expect.assertions(1);

		const offenders = serverModules()
			.filter((path) => !OUTBOUND_SURFACE.includes(path))
			.filter((path) => identifierHits(readSource(path), /(?<![.\w$])fetch\b/g).length > 0);

		expect(
			offenders,
			`server modules naming fetch outside the declared outbound surface: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('v5.0.0-13.2.5: no alternative HTTP client can reach the network', () => {
		expect.assertions(1);

		const offenders = serverModules().filter((path) => {
			const source = readSource(path);
			const comments = blockCommentRanges(source);
			return [...source.matchAll(new RegExp(ALTERNATIVE_CLIENTS, 'g'))].some(
				(match) => !isInComment(source, match.index, comments)
			);
		});

		expect(offenders, `HTTP clients that bypass the guard: ${offenders.join(', ')}`).toEqual([]);
	});

	/**
	 * The realistic regression, in the form this codebase would actually produce it.
	 *
	 * The Ollama SDK is a third-party HTTP client. It is contained only because every construction
	 * passes a `fetch:` option routing through `fetchWithRedirectGuard`. Drop that one property and
	 * the SDK falls back to the global fetch, the guard is gone, and nothing else in this file
	 * notices: the import is unchanged, `fetchWithRedirectGuard` is still imported at the top, and
	 * the module still appears on the declared outbound surface.
	 */
	it('v5.0.0-13.2.5: every SDK construction is handed a guarded fetch', () => {
		expect.assertions(2);

		const constructions: { path: string; guarded: boolean }[] = [];
		for (const path of serverModules()) {
			const source = readSource(path);
			const comments = blockCommentRanges(source);
			for (const match of source.matchAll(/new\s+Ollama\s*\(/g)) {
				if (isInComment(source, match.index, comments)) continue;
				// The construction's own argument object, brackets balanced from the opening paren.
				const call = source.slice(match.index, match.index + 2000);
				constructions.push({
					path,
					guarded: /fetch:\s*\(/.test(call.slice(0, call.indexOf('});') + 1))
				});
			}
		}

		// Calibration: an SDK that is no longer constructed anywhere would satisfy the assertion
		// below by having nothing to check.
		expect(constructions.length).toBeGreaterThan(0);
		expect(
			constructions.filter((c) => !c.guarded).map((c) => c.path),
			'an SDK constructed without a guarded fetch reaches the network directly'
		).toEqual([]);
	});

	it('v5.0.0-12.3.2: nothing anywhere disables TLS certificate verification', () => {
		expect.assertions(1);

		const offenders: string[] = [];
		for (const path of productionSourceFiles()) {
			const source = readSource(path);
			const comments = blockCommentRanges(source);
			const strings = stringLiteralRanges(source);
			for (const pattern of TLS_VERIFICATION_DISABLERS) {
				for (const match of source.matchAll(new RegExp(pattern, 'g'))) {
					if (
						!isInComment(source, match.index, comments) &&
						!isInStringLiteral(source, match.index, strings)
					) {
						offenders.push(`${path}: ${match[0]}`);
					}
				}
			}
		}

		expect(offenders, `TLS verification weakened: ${offenders.join(', ')}`).toEqual([]);
	});

	// The string-literal filter's own test, with the two cases that bit. Without it this file
	// reported `banking/sync/service.ts` and `enablebanking.sandbox-validation.ts` as unguarded
	// outbound clients, on the strength of the English word "fetch" inside a log message.
	it('the string filter separates an identifier from the same word in a message', () => {
		expect.assertions(3);

		const fixture = [
			'const msg = `[bank-sync] balance fetch failed for connection ${id}`;',
			"throw new Error('Session has no accounts to fetch transactions from');",
			'const real = options.fetchImpl ?? fetch;'
		].join('\n');

		const all = [...fixture.matchAll(/(?<![.\w$])fetch\b/g)];
		expect(all).toHaveLength(3);

		const inCode = identifierHits(fixture, /(?<![.\w$])fetch\b/g);
		expect(inCode).toHaveLength(1);

		// And the interpolation inside that template is still code, not string.
		expect(isInStringLiteral(fixture, fixture.indexOf('id}'))).toBe(false);
	});
});
