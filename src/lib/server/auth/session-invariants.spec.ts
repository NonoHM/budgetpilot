import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createSessionToken, getSessionExpiresAt, hashSessionToken } from '$lib/server/auth';
import {
	blockCommentRanges,
	isInComment,
	isInStringLiteral,
	productionSourceFiles,
	readSource,
	stringLiteralRanges
} from '$lib/server/security/sourceScan';

/**
 * Session invariants: check 8 of the Phase 5 automation inventory, covering `v5.0.0-7.2.3` (session
 * token entropy), `v5.0.0-7.3.2` (an absolute maximum session lifetime enforced server-side) and
 * `v5.0.0-7.6.2` (no session comes into existence without deliberate user action).
 *
 * `v5.0.0-7.2.1` is the fourth row of this check and is NOT here. It is about what
 * `readSessionUser` does against the database, and a unit test would inject the query's own result,
 * which is the shape `CLAUDE.md` records under "Unit tests cannot see a wrong SQL predicate". It
 * lives in `session.db-smoke.ts`, against a real engine.
 *
 * NOTHING IS MOCKED IN THIS FILE, AND THAT IS THE POINT RATHER THAN AN ACCIDENT. The natural home
 * for these assertions is `auth.spec.ts`, which already imports every one of these functions. It
 * also opens with `vi.mock('$lib/server/db', ...)`, and this phase has already shipped one test that
 * asserted a constant its own file had mocked: the cookie-prefix pin, which stayed green through a
 * rename of the real `SESSION_COOKIE` and is why `cookie-names.spec.ts` exists. A mock is declared
 * per file and cannot be narrowed to a describe block, so the only way to keep these pinned to the
 * real module is a file that mocks nothing. Do not merge this back into `auth.spec.ts`.
 *
 * WHAT A TEST CANNOT SAY ABOUT RANDOMNESS, stated so the entropy assertions are not read as more
 * than they are. No assertion here proves a CSPRNG. What it can separate is the two states a
 * refactor actually produces: a token shortened to a friendlier length, and a token minted from
 * something ordered (a counter, a timestamp, an incrementing id) that is still unique. Length
 * catches the first. A per-position byte-variation floor catches the second, which uniqueness alone
 * cannot: a counter is perfectly unique and its high bytes never move.
 *
 * THE BREAK MATRIX, ten breaks against the twenty tests of this file and `session.db-smoke.ts`,
 * read per test. Baseline 20/20, every break red on the test aimed at. Two of the breaks changed
 * this file rather than confirming it, and three of the greens are findings:
 *
 *  - `the token comes from a counter` came back ALL GREEN the first time, and that is the most
 *    useful result in the set. The assertion then pooled all 32000 bytes and required 200 distinct
 *    values; a counter scores **256**, because its low byte cycles through the whole range while
 *    twenty-eight higher bytes stay at zero. The pooled count was a PROXY for entropy and the
 *    counter satisfied the proxy exactly. Per position it is 1 against `randomBytes`'s measured 246.
 *  - `the matcher counts the definition` turned the call-site test red and left the MATCHER'S OWN
 *    TEST green, because that test had retyped the regex instead of calling it. An oracle that
 *    restates the rule it audits certifies its own copy. It now calls `sessionCreationCallsIn`, and
 *    the break reddens both.
 *  - `SESSION_TTL_DAYS is ignored and 30 is hardcoded`: only the "honours" test red. The unset case
 *    and all seven malformed cases stay GREEN, because every one of them expects 30. That test is
 *    the only thing in the file that can see a hardcoded ceiling, so it is not redundant with the
 *    fallback block however much it reads like a weaker version of it.
 *  - `the fallback guard is removed`: the seven malformed cases red and the UNSET case green, since
 *    `??` still supplies the default when the variable is absent. The two halves guard different
 *    things despite reading as one family.
 *  - `readSessionUser always refuses`: the db-smoke calibration red, and the revoked and expired
 *    tests red WITH it, precisely because they assert the session resolves before changing the one
 *    thing under test. Written as bare absences they would both have been green.
 */

/** Documented in `docs/configuration.md`, `docs/reference/account.md` and `.env.example`. */
const DOCUMENTED_DEFAULT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const originalTtl = process.env.SESSION_TTL_DAYS;

afterEach(() => {
	if (originalTtl === undefined) delete process.env.SESSION_TTL_DAYS;
	else process.env.SESSION_TTL_DAYS = originalTtl;
});

describe('v5.0.0-7.2.3: session token entropy', () => {
	it('a token decodes to exactly 32 bytes, which is 256 bits', () => {
		expect.assertions(2);

		const token = createSessionToken();
		expect(Buffer.from(token, 'base64url')).toHaveLength(32);
		// base64url specifically: a token carrying `+`, `/` or `=` would need escaping in a
		// Set-Cookie value, and the alphabet is part of why it does not.
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('a thousand tokens are all distinct AND every byte position varies', () => {
		expect.assertions(2);

		const tokens = Array.from({ length: 1000 }, () => createSessionToken());
		expect(new Set(tokens).size).toBe(1000);

		// The half uniqueness cannot provide, and the floor is PER POSITION rather than over the
		// pooled bytes. That distinction is measured rather than reasoned: the first version of this
		// assertion pooled all 32000 bytes and required more than 200 distinct values, and the
		// counter break-check came back GREEN AT 256, because a counter's low byte cycles through
		// every value in the range while twenty-eight higher bytes stay at zero forever. The pooled
		// count was a proxy for entropy and a counter satisfies the proxy exactly.
		//
		// Per position it is decisive and not close: over 1000 samples a counter's worst position
		// holds 1 distinct value and `randomBytes` holds 246, against an expectation of ~251. The
		// floor of 200 sits far enough below 246 that a flake is not a real possibility.
		const perPosition = Array.from(
			{ length: 32 },
			(_, index) => new Set(tokens.map((token) => Buffer.from(token, 'base64url')[index])).size
		);
		expect(Math.min(...perPosition)).toBeGreaterThan(200);
	});

	it('the token is stored only as a hash, and the hash is not the token', () => {
		expect.assertions(3);

		const token = createSessionToken();
		const hash = hashSessionToken(token);

		expect(hash).not.toBe(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// Deterministic, because the lookup in `readSessionUser` is by hash equality.
		expect(hashSessionToken(token)).toBe(hash);
	});
});

describe('v5.0.0-7.3.2: the absolute session lifetime', () => {
	/** Days between now and `expiresAt`, rounded to survive the milliseconds the call itself takes. */
	function ttlDaysOf(expires: Date): number {
		return Math.round((expires.getTime() - Date.now()) / DAY_MS);
	}

	// The load-bearing one, and the one a fallback-only suite would omit. Every assertion below it
	// is satisfied by a function that ignores the environment entirely and always returns 30, so
	// without this the whole describe block is green over a hardcoded ceiling.
	it('honours SESSION_TTL_DAYS when it is a sane value', () => {
		expect.assertions(2);

		process.env.SESSION_TTL_DAYS = '7';
		expect(ttlDaysOf(getSessionExpiresAt())).toBe(7);

		process.env.SESSION_TTL_DAYS = '1';
		expect(ttlDaysOf(getSessionExpiresAt())).toBe(1);
	});

	it('falls back to the documented 30 days when it is unset', () => {
		expect.assertions(1);

		delete process.env.SESSION_TTL_DAYS;
		expect(ttlDaysOf(getSessionExpiresAt())).toBe(DOCUMENTED_DEFAULT_TTL_DAYS);
	});

	// The refusals matter more than the default: each of these, taken literally, would produce a
	// session that never expires (NaN, so the comparison in `readSessionUser` is always false) or
	// one already expired at creation. A silent fallback is the correct behaviour and it is
	// invisible, so it is pinned.
	it.each(['', 'abc', '0', '-5', 'Infinity', 'NaN', '30days'])(
		'refuses %o and falls back to 30 rather than producing a session that never expires',
		(value) => {
			expect.assertions(1);

			process.env.SESSION_TTL_DAYS = value;
			expect(ttlDaysOf(getSessionExpiresAt())).toBe(DOCUMENTED_DEFAULT_TTL_DAYS);
		}
	);
});

/**
 * The three call sites, as published. Each is the direct result of a deliberate credential
 * submission: a password, a TOTP code, a registration.
 *
 * A closed list rather than a count, because the requirement is about WHICH interactions mint a
 * session. A fourth entry is a decision, and the reviewable question is what user action stands
 * behind it.
 */
const SESSION_CREATION_SITES = [
	join('src', 'routes', 'login', '+page.server.ts'),
	join('src', 'routes', 'login', 'verify-totp', '+page.server.ts'),
	join('src', 'routes', 'register', '+page.server.ts')
];

/**
 * Files that CALL `createSession`, which is not the same as files that name it.
 *
 * Three things are deliberately not matches. The definition in `auth.ts` is preceded by `function`.
 * An `import { createSession }` names it without calling it. And `createSessionToken(` shares the
 * first thirteen characters, which is why the paren is part of the pattern rather than a word
 * boundary alone.
 */
function sessionCreationCallsIn(source: string): number {
	const comments = blockCommentRanges(source);
	const strings = stringLiteralRanges(source);
	return [...source.matchAll(/(?<!function\s)\bcreateSession\s*\(/g)].filter(
		(match) =>
			!isInComment(source, match.index, comments) &&
			!isInStringLiteral(source, match.index, strings)
	).length;
}

function sessionCreationCallers(files: string[] = productionSourceFiles()): string[] {
	return files.filter((path) => sessionCreationCallsIn(readSource(path)) > 0);
}

describe('v5.0.0-7.6.2: no session is created without deliberate user action', () => {
	it('createSession is called from exactly the three declared modules', () => {
		expect.assertions(1);

		// An equality rather than a subset. A new caller is the whole point of this check, and a
		// containment assertion would let one through.
		expect(sessionCreationCallers().sort()).toEqual([...SESSION_CREATION_SITES].sort());
	});

	// The matcher's own test, with all four near-misses in one fixture. Without it, "exactly three"
	// is equally consistent with a pattern that has stopped matching anything and a codebase that
	// happens to have three files naming the word.
	//
	// IT CALLS `sessionCreationCallsIn` RATHER THAN RESTATING THE PATTERN, and that is not tidiness.
	// The first version inlined its own copy of the regex, and the break-check that widened the REAL
	// pattern to count the `function createSession(` definition turned the call-site test red and
	// left this one GREEN. An oracle that retypes the rule it audits certifies its own copy, which
	// `CLAUDE.md` records from a `volume.spec.ts` oracle that had drifted from the helper it checked
	// by exactly the clause it forgot. Reading that green is the only reason this now shares code.
	it('the matcher separates a call from a definition, an import, a comment and a longer name', () => {
		expect.assertions(2);

		const fixture = [
			"import { createSession, createSessionToken } from '$lib/server/auth';",
			'export async function createSession(userId: string) {}',
			'// await createSession(user.id, cookies);',
			"const label = 'await createSession(x)';",
			'const token = createSessionToken();',
			'await createSession(user.id, cookies);'
		].join('\n');

		// Five of the six lines name it; exactly one of them is a call.
		expect([...fixture.matchAll(/createSession/g)].length).toBeGreaterThan(4);
		expect(sessionCreationCallsIn(fixture)).toBe(1);
	});
});
