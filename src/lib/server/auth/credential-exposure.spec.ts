import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
	blockCommentRanges,
	callTextAt,
	isInComment,
	productionSourceFiles,
	readSource,
	balancedFrom
} from '$lib/server/security/sourceScan';

/**
 * Structural credential scan: check 4 of the Phase 5 automation inventory, covering
 * `v5.0.0-15.3.1` (return only the required subset of fields) and `v5.0.0-8.2.3` (field-level
 * access restricted to consumers with permission to those fields).
 *
 * Both rows are met BY CONSTRUCTION rather than by a control anyone can point at, which is
 * exactly the kind of verdict a point-in-time assessment cannot keep. The evidence is a count:
 * every `prisma.user.find*` passes an explicit `select`, so no user row is fetched wholesale, and
 * the two credential columns are selected only where a credential is genuinely being verified.
 * Nothing enforced that. One query written without a `select` would have made the published
 * sentence false with no test going red, and the query would have looked entirely ordinary.
 *
 * SCOPE, stated because it is narrower than the requirement. `v5.0.0-15.3.1` is about every data
 * object; this scans the USER model, because that is where the credentials are and because a
 * whole-schema version would drown in rows nobody is worried about. The report's automatable
 * note scopes it the same way.
 *
 * WIDER THAN THE PUBLISHED FIGURE IN ONE RESPECT, and the numbers should be read together. The
 * assessment counted 12 of 12 under `src/routes/`; that is confirmed exactly. This scans all of
 * `src/` and finds 15, the extra three being `auth/registration.ts`, `backup/export.ts` and
 * `naming/backfill.ts`, all of which pass a `select` too. A guard pointed only at the directory
 * the evidence happened to mention would not have looked at them.
 */

/** The two columns whose disclosure is the thing being prevented. */
const CREDENTIAL_FIELDS = ['passwordHash', 'totpSecretEncrypted'] as const;

/**
 * The only paths allowed to SELECT a credential column, and each one verifies a secret:
 * `/login` compares a password, `/login/verify-totp` decrypts a TOTP secret, and `/settings` is
 * the re-authentication surface for the sensitive actions (#220, #230).
 *
 * A closed list rather than a pattern, because "which files may read a password hash" is a
 * decision and should read as one. Adding an entry should be as visible as it is consequential.
 */
const CREDENTIAL_PATHS = [
	join('src', 'routes', 'login', '+page.server.ts'),
	join('src', 'routes', 'login', 'verify-totp', '+page.server.ts'),
	join('src', 'routes', 'settings', '+page.server.ts')
];

/**
 * The `select:` object literal of a call, or '' when there is none.
 *
 * Extracted rather than searched for as a substring of the whole call, so that WRITING a
 * credential (`data: { passwordHash }`, which registration and password change legitimately do)
 * is never mistaken for RETURNING one. The distinction is the entire point of the requirement:
 * v5.0.0-15.3.1 is about what comes back.
 */
function selectBlockOf(callText: string): string {
	const at = callText.indexOf('select:');
	if (at === -1) return '';
	return balancedFrom(callText, callText.indexOf('{', at), '{', '}');
}

interface UserQuery {
	path: string;
	method: string;
	hasSelect: boolean;
	credentialsSelected: string[];
}

function findUserQueries(): UserQuery[] {
	const queries: UserQuery[] = [];
	for (const path of productionSourceFiles()) {
		const source = readSource(path);
		const blocks = blockCommentRanges(source);
		for (const match of source.matchAll(/prisma\.user\.(\w+)/g)) {
			if (isInComment(source, match.index, blocks)) continue;
			const callText = callTextAt(source, match.index + match[0].length);
			const selectBlock = selectBlockOf(callText);
			queries.push({
				path,
				method: match[1],
				hasSelect: selectBlock !== '',
				credentialsSelected: CREDENTIAL_FIELDS.filter((field) => selectBlock.includes(field))
			});
		}
	}
	return queries;
}

describe('credential exposure (v5.0.0-15.3.1, v5.0.0-8.2.3)', () => {
	// Before any empty offender list is believed. A scan whose matcher broke, or which was pointed
	// at the wrong directory, reports exactly the same empty list as a codebase that is correct.
	//
	// Measured, not argued: pointing `productionSourceFiles` at `src/lib/components` instead of
	// `src` turns THIS test red and leaves both offender tests below GREEN, because a scan over
	// zero server files finds zero offenders. That is the vacuous pass, and this is the only test
	// in the file that can see it.
	it('calibration: the scan reaches the code, including every credential path by name', () => {
		expect.assertions(3);

		const queries = findUserQueries();
		const reads = queries.filter((query) => query.method.startsWith('find'));

		// The published assessment counts 12 under src/routes/. Asserted as a floor rather than an
		// equality so that adding a legitimate query is not a failure, and sized well below the
		// measured 15 so it is a statement about the matcher working, not about the inventory.
		expect(reads.length).toBeGreaterThanOrEqual(12);

		// Sharper than the count: the three files where a credential is genuinely read must each be
		// visible to the scan. If they are, a new query added beside one of them is visible too.
		const seen = new Set(queries.map((query) => query.path));
		expect(CREDENTIAL_PATHS.filter((path) => !seen.has(path))).toEqual([]);

		// And the scan must be able to SEE a credential in a select, or the exclusion test below is
		// asserting an absence it could never have observed. Appear, then disappear.
		expect(queries.filter((query) => query.credentialsSelected.length > 0)).not.toEqual([]);
	});

	it('every production prisma.user.find* passes an explicit select', () => {
		expect.assertions(1);

		const offenders = findUserQueries()
			.filter((query) => query.method.startsWith('find'))
			.filter((query) => !query.hasSelect)
			.map((query) => `${query.path} (prisma.user.${query.method})`);

		expect(
			offenders,
			`user rows fetched wholesale, so every column including the credentials comes back: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('no select outside the three credential paths returns passwordHash or totpSecretEncrypted', () => {
		expect.assertions(1);

		const offenders = findUserQueries()
			.filter((query) => query.credentialsSelected.length > 0)
			.filter((query) => !CREDENTIAL_PATHS.includes(query.path))
			.map((query) => `${query.path} selects ${query.credentialsSelected.join(', ')}`);

		expect(
			offenders,
			`credential columns selected outside login, verify-totp and settings: ${offenders.join(', ')}`
		).toEqual([]);
	});

	// The client-side half, and the cheapest strong statement in this file. A credential column
	// reaching a component means it travelled through a `load` return or a form result, which is
	// the disclosure v5.0.0-15.3.1 exists to prevent, and it is visible as a plain name.
	it('no credential column name appears in any Svelte component', () => {
		expect.assertions(2);

		const components = productionSourceFiles().filter((path) => path.endsWith('.svelte'));

		// Calibration: an empty file list would satisfy the assertion below without meaning
		// anything at all.
		expect(components.length).toBeGreaterThan(50);

		const offenders = components.filter((path) => {
			const source = readSource(path);
			const blocks = blockCommentRanges(source);
			return CREDENTIAL_FIELDS.some((field) =>
				[...source.matchAll(new RegExp(field, 'g'))].some(
					(match) => !isInComment(source, match.index, blocks)
				)
			);
		});

		expect(offenders, `credential names in components: ${offenders.join(', ')}`).toEqual([]);
	});

	// The matcher's own test, with the case that actually bit. Everything above is an absence
	// assertion resting on this function being right, and "found nothing" is what both a correct
	// scan and a broken one report.
	//
	// Break-checked in the other direction too: disabling `isInComment` turns this red AND makes
	// the select test report `src/lib/server/auth.ts` as a query fetching user rows wholesale,
	// which is the phantom finding that prompted the filter in the first place.
	it('the comment filter separates a real call from one written in prose', () => {
		expect.assertions(2);

		const fixture = [
			'/**',
			' * Historically "a\\x00b@example.com" reached prisma.user.findUnique and threw.',
			' */',
			'// const stale = prisma.user.findMany();',
			'const real = await prisma.user.findUnique({ where: { id }, select: { id: true } });'
		].join('\n');

		const blocks = blockCommentRanges(fixture);
		const found = [...fixture.matchAll(/prisma\.user\.(\w+)/g)];

		// Three occurrences are present; the filter must keep exactly the one that is code.
		expect(found).toHaveLength(3);
		expect(found.filter((match) => !isInComment(fixture, match.index, blocks))).toHaveLength(1);
	});
});
