import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
	blockCommentRanges,
	callTextAt,
	isInComment,
	productionSourceFiles,
	readSource
} from './sourceScan';

/**
 * Cryptographic algorithm allowlist: check 5 of the Phase 5 automation inventory. Six rows from
 * one scan: `v5.0.0-11.2.1` (industry-validated implementations), `11.3.1` (no insecure block
 * modes or weak padding), `11.3.2` (approved ciphers and modes), `11.4.1` and `11.4.3` (approved,
 * collision-resistant hashes), `11.6.1` (approved algorithms for key generation and signatures).
 *
 * All six are met by construction, and the construction is a handful of string literals. AES-256
 * becomes AES-128 by editing one character; `sha256` becomes `sha1` by deleting two. Nothing
 * would have noticed, and none of the six rows would have been false in a way any existing test
 * could see.
 *
 * IT IS AN ALLOWLIST OVER CALL ARGUMENTS, NOT A DENYLIST OVER TEXT, and that is a measurement
 * rather than a preference. A text scan for weak-algorithm names is unusable in this repository:
 *
 *  - **`\bdes\b` matches 7 times**, every one of them the French article, in
 *    `SplitPartRow.svelte`, `budgets/+page.svelte`, `net-worth/+page.svelte`,
 *    `settings/+page.svelte` and `transactions/+page.svelte`. This application's UI is French.
 *  - **`\bnone\b` matches 358 times**, essentially all CSS.
 *
 * The published evidence already warned that a naive `des` pattern matches `desc` and floods on
 * the generated Prisma clients. The bilingual half is worse and was not recorded: `des` is a word
 * here. So the primary assertion extracts the algorithm ARGUMENT of each `node:crypto` factory
 * call and checks it against a closed approved set, which cannot be fooled by prose in either
 * language. A denylist survives only for tokens that are unambiguous (`md5`, `sha1`, `rc4`,
 * `blowfish`, `createCipher(`), and `des` and `none` are deliberately NOT among them.
 */

/**
 * Every algorithm this application is allowed to name, with the reason it is here.
 *
 * A closed set, so ADDING one is a visible decision rather than a passing edit. That is the
 * whole mechanism: the scan cannot know whether `aes-128-cbc` is a mistake, but it can insist
 * that somebody wrote it down here first.
 */
const APPROVED_ALGORITHMS = new Set([
	// AEAD, no padding, random IV per encryption, auth tag verified on decrypt. The only
	// symmetric encryption in the application: TOTP secrets at rest (crypto.ts).
	'aes-256-gcm',
	// Session and invitation token hashing, import dedupe keys, advisory-lock names, the
	// constant-time comparison digest, and HMAC for rate-limit keys.
	'sha256'
]);

/** The `node:crypto` factories whose first argument names an algorithm. */
const CRYPTO_FACTORIES = /\bcreate(?:Hash|Hmac|Cipheriv|Decipheriv|Sign|Verify)\s*(?=\()/g;

/**
 * The keyless legacy API. `createCipher` derives a key from a passphrase with MD5 and uses a
 * zero IV; it is deprecated and unsafe, and it differs from the correct call by four characters.
 */
const LEGACY_KEYLESS_API = /\bcreate(?:Cipher|Decipher)\s*\(/g;

/**
 * Tokens that cannot mean anything but a weak primitive in this codebase.
 *
 * `des` and `none` are excluded by measurement, not by oversight: see the file docstring. They
 * are covered by the allowlist instead, which is the stronger check anyway because it sees the
 * argument rather than the word.
 */
const UNAMBIGUOUS_WEAK_TOKENS = [/\bmd5\b/i, /\brc4\b/i, /\bblowfish\b/i, /\bsha-?1\b/i];

interface AlgorithmUse {
	path: string;
	call: string;
	algorithm: string | null;
}

/** Every `node:crypto` factory call in production source, with its algorithm argument. */
function algorithmUses(): AlgorithmUse[] {
	const uses: AlgorithmUse[] = [];
	for (const path of productionSourceFiles()) {
		const source = readSource(path);
		const blocks = blockCommentRanges(source);
		for (const match of source.matchAll(CRYPTO_FACTORIES)) {
			if (isInComment(source, match.index, blocks)) continue;
			const call = callTextAt(source, match.index + match[0].length);
			// The first argument, and only when it is a plain string literal. A computed algorithm
			// is not an offender by itself, but it is unverifiable by this scan, so it is reported
			// rather than skipped: silence would be the scan claiming coverage it does not have.
			const literal = /^\(\s*(['"`])([^'"`]*)\1/.exec(call);
			uses.push({ path, call: match[0], algorithm: literal ? literal[2] : null });
		}
	}
	return uses;
}

describe('cryptographic algorithm allowlist (v5.0.0-11.2.1, 11.3.1, 11.3.2, 11.4.1, 11.4.3, 11.6.1)', () => {
	// An empty offender list means nothing until the scan is known to reach the code. A matcher
	// that found no crypto calls at all would report a perfectly clean allowlist.
	it('calibration: the scan finds the real crypto call sites', () => {
		expect.assertions(3);

		const uses = algorithmUses();

		expect(uses.length).toBeGreaterThanOrEqual(8);

		// Named files, so a scan that drifted to the wrong subtree is caught by more than a count.
		// These are the two that matter most: the only symmetric encryption, and the token hash.
		const paths = new Set(uses.map((use) => use.path));
		expect(paths.has(join('src', 'lib', 'server', 'crypto.ts'))).toBe(true);
		expect(paths.has(join('src', 'lib', 'server', 'auth.ts'))).toBe(true);
	});

	it('every algorithm passed to a node:crypto factory is on the approved list', () => {
		expect.assertions(1);

		const offenders = algorithmUses()
			.filter((use) => use.algorithm === null || !APPROVED_ALGORITHMS.has(use.algorithm))
			.map((use) => `${use.path}: ${use.call}(${use.algorithm ?? 'NOT A LITERAL'})`);

		expect(
			offenders,
			`algorithms outside the approved set (add it to APPROVED_ALGORITHMS with its reason, or fix the call): ${offenders.join(', ')}`
		).toEqual([]);
	});

	// v5.0.0-11.3.1 specifically. `createCipher` differs from `createCipheriv` by two characters
	// and is a different, unsafe primitive: it derives the key from a passphrase with MD5 and uses
	// a zero IV.
	it('the keyless legacy cipher API appears nowhere', () => {
		expect.assertions(1);

		const offenders = productionSourceFiles().filter((path) => {
			const source = readSource(path);
			const blocks = blockCommentRanges(source);
			return [...source.matchAll(LEGACY_KEYLESS_API)].some(
				(match) => !isInComment(source, match.index, blocks)
			);
		});

		expect(offenders, `keyless createCipher/createDecipher: ${offenders.join(', ')}`).toEqual([]);
	});

	it('no unambiguously weak primitive is named anywhere in production source', () => {
		expect.assertions(1);

		const offenders: string[] = [];
		for (const path of productionSourceFiles()) {
			const source = readSource(path);
			const blocks = blockCommentRanges(source);
			for (const pattern of UNAMBIGUOUS_WEAK_TOKENS) {
				for (const match of source.matchAll(new RegExp(pattern, 'gi'))) {
					if (!isInComment(source, match.index, blocks)) {
						offenders.push(`${path}: ${match[0]}`);
					}
				}
			}
		}

		expect(offenders, `weak primitives named: ${offenders.join(', ')}`).toEqual([]);
	});

	// v5.0.0-11.6.1. The one signature this application produces, and the one place an `alg` is
	// chosen. `alg: 'none'` is the classic JWT forgery, and RS256 here is deliberate: it is what
	// the Enable Banking API contract mandates, and it is the PKCS#1 v1.5 SIGNATURE scheme, still
	// FIPS 186-5 approved, not the encryption scheme the requirement's example is about.
	it('the outbound JWT is signed with RS256, in both places that name it', () => {
		expect.assertions(3);

		const jwt = readSource(join('src', 'lib', 'server', 'banking', 'enablebanking', 'jwt.ts'));

		expect(jwt).toContain("importPKCS8(credentials.privateKeyPem, 'RS256')");
		expect(jwt).toMatch(/setProtectedHeader\(\{[^}]*alg: 'RS256'/);
		expect(jwt).not.toMatch(/alg:\s*'none'/);
	});

	// The extractor's own test. Everything above is an absence assertion resting on this function
	// being able to see a bad value, and "found nothing" is what a correct scan and a broken one
	// both report. Appear, then disappear.
	it('the extractor reads the algorithm argument, and would refuse a weak one', () => {
		expect.assertions(4);

		const fixture = [
			"// createHash('md5') in a comment must not count",
			"const good = createHash('sha256');",
			"const bad = createCipheriv('aes-128-ecb', key, iv);",
			'const computed = createHash(chosenAlgorithm);'
		].join('\n');

		const blocks = blockCommentRanges(fixture);
		const found = [...fixture.matchAll(CRYPTO_FACTORIES)].filter(
			(match) => !isInComment(fixture, match.index, blocks)
		);

		// Three calls in code, one in a comment.
		expect(found).toHaveLength(3);

		const algorithms = found.map((match) => {
			const call = callTextAt(fixture, match.index + match[0].length);
			const literal = /^\(\s*(['"`])([^'"`]*)\1/.exec(call);
			return literal ? literal[2] : null;
		});

		expect(algorithms).toEqual(['sha256', 'aes-128-ecb', null]);
		// The weak one is rejected by the allowlist, and the computed one is reported rather than
		// silently skipped.
		expect(algorithms.filter((a) => a !== null && !APPROVED_ALGORITHMS.has(a))).toEqual([
			'aes-128-ecb'
		]);
		expect(algorithms.filter((a) => a === null)).toHaveLength(1);
	});

	// sourceScan.ts is test-only, and this is what enforces it rather than asking for it. The
	// standing lesson: an optional convention stays at its first reader.
	it('the shared scan helper is imported by no production module', () => {
		expect.assertions(2);

		const importers = productionSourceFiles().filter(
			(path) =>
				!path.endsWith(join('security', 'sourceScan.ts')) &&
				/from '.*security\/sourceScan'/.test(readSource(path))
		);

		// Calibration: the helper file itself must be in the population, or this assertion is
		// about an empty list.
		expect(productionSourceFiles()).toContain(
			join('src', 'lib', 'server', 'security', 'sourceScan.ts')
		);
		expect(
			importers,
			`production modules importing a test-only helper: ${importers.join(', ')}`
		).toEqual([]);
	});
});
