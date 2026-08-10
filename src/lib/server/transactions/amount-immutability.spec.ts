import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Split parts only survive a re-import, and only stay reconciled with their parent, because the
 * parent row's `amountCents` is never rewritten once it exists: `replaceSplits` (splits.ts) checks
 * `Σ parts === parent.amountCents` at write time, against the parent it just re-read inside the
 * same transaction. If some later feature — bank reconciliation is the obvious candidate — starts
 * correcting an EXISTING transaction's amount, that invariant is not re-checked, because nothing
 * calls back into the split logic to re-validate it. Every répartition on that transaction then
 * silently carries a non-zero remainder: `allocationsOf` reports it as money appearing or
 * vanishing under the parent's own category, with nothing pointing at the write that caused it.
 *
 * Today that protection is INCIDENTAL, not structural: it holds only because no write path happens
 * to set `amountCents` on a row that already exists, not because anything forbids it. This spec
 * makes the rule explicit, so the day a write path starts doing that, this goes red naming the
 * file and line, and the sum-invariant question gets asked on purpose instead of by accident.
 *
 * ---- Scope: create is exempt, on purpose -----------------------------------------------------
 *
 * `create`, `createMany`, and the `create` branch of `upsert` legitimately set `amountCents`: an
 * import or a restore is bringing a NEW row into existence and has to give it an amount. Only
 * `update`, `updateMany`, and the `update` branch of `upsert` are in scope, because those are the
 * only three operations that can touch a row that already has an `amountCents` some split may
 * already sum against.
 *
 * ---- Roots scanned, and why -------------------------------------------------------------------
 *
 * `src` is scanned in full (every `.ts` file, generated Prisma client output excepted — see
 * below). Two more roots were checked deliberately rather than assumed clean, per the standing
 * "a gate only guards the directories it is pointed at" rule:
 *   - `e2e/` holds `.ts` that calls into the database directly for seeding (`e2e/bills-seed.ts`)
 *     and is scanned for the same reason `src` is.
 *   - `scripts/` holds `.mjs` that also opens a `PrismaClient` directly (`scripts/seed-dev.mjs`
 *     among others) and is scanned as `.mjs` text for the same call-site pattern.
 *   - `prisma/` was checked and excluded: it holds only `.prisma` schema text and generated SQL
 *     migrations, no `.ts`/`.mjs` code of its own (`find prisma -type f | grep -v migrations`
 *     lists three `schema*.prisma` files and nothing else), so there is nothing there for a
 *     text scan to read.
 * As of this writing every call site this scan finds under `e2e/` and `scripts/` is a `.create`
 * or a `.deleteMany`; the two roots are included so that stays true by construction rather than
 * by nobody having looked.
 *
 * ---- Approach, and what it cannot see -----------------------------------------------------
 *
 * This is a source scan, not a query-level or type-level check: it finds every
 * `<identifier>.transaction.update(`, `.updateMany(`, or `.upsert(` call by text, then opens the
 * `data:` (or, for `upsert`, `update:`) argument with a small hand-rolled bracket-matching walk —
 * the "light hand-rolled scan" option, chosen over pulling in the TypeScript compiler API for a
 * check this narrow. The walk treats `'...'`, `"..."`, and `` `...` `` as opaque spans (their
 * contents are never inspected for brackets) and skips `//` and `/* *‍/` comments, so ordinary
 * reformatting cannot defeat it by shifting brace positions around.
 *
 * Stated blind spots, not discovered later and patched around:
 *
 * 1. A template literal that itself contains an unbalanced-looking `{`/`}` inside a `${...}`
 *    interpolation is not specially handled — the whole backtick string is opaque text, the walk
 *    never descends into the interpolation. None of the call sites this scan currently inspects
 *    put a template literal directly inside a `data:`/`update:` object (checked by hand against
 *    every site this file finds); if one ever does, the bracket walk can misjudge where the
 *    object ends.
 * 2. Only `<word>.transaction.<method>(` is matched. A destructured or re-exported client
 *    (`const { transaction } = prisma; transaction.updateMany(...)`) would not be seen. Checked:
 *    nothing in `src`, `e2e`, or `scripts` destructures a Prisma client this way today
 *    (`grep -rn "const { transaction }" src e2e scripts` finds nothing).
 * 3. `data:`/`update:` can be a value this scan cannot open as a literal object: a bare call
 *    expression (`data: manualCategoryUpdate(newName)`) or a spread of one
 *    (`data: { ...manualCategoryUpdate(x) }`). The scan cannot see what such a helper's return
 *    value contains — that would need to import and inspect the helper's actual output, which is
 *    a different kind of test. Rather than silently trusting an unknown helper, or silently
 *    ignoring it, every such call site is classified `unresolvable` and fails its own assertion
 *    UNLESS the helper's name is in `KNOWN_SAFE_DATA_HELPERS` below, each entry there carrying the
 *    reason it was actually read and found not to touch `amountCents`. A new helper used this way
 *    makes the "unresolvable" test fail, naming the file and line, until someone adds it to that
 *    list on purpose.
 * 4. `amountCents` cannot legally appear nested one level deeper than `data`/`update` for a
 *    `Transaction` write — it is a plain scalar column, not a relation, confirmed by reading the
 *    generated client's own type
 *    (`TransactionUpdateInput.amountCents?: Prisma.IntFieldUpdateOperationsInput | number` in
 *    `src/lib/server/database/generated/sqlite/models/Transaction.ts`) — so the scan only opens
 *    the top-level `data:`/`update:` object and does not need to recurse further to catch a
 *    direct write.
 * 5. Raw SQL is invisible to a scan that reads Prisma call sites. There is none that writes today,
 *    and that absence is PINNED by a test below rather than asserted here in prose, because a
 *    sentence in a docstring stops being true silently and an assertion does not.
 *
 * Test-only files (`*.spec.ts`, `*.db-smoke.ts`) are excluded from the production scan, and this
 * is a deliberate exclusion with a concrete example, not an oversight: `allocation.db-smoke.ts`
 * deliberately writes `amountCents: -6_000` onto an existing row that already has split parts
 * summing to a different total, specifically to prove `allocationsOf` reports the resulting
 * remainder correctly. That is a legitimate simulation of a write no production path performs
 * today, not a violation of the rule this file enforces — flagging it would be exactly the
 * "harness re-implements the thing under test and calls the difference a bug" mistake. One test
 * below pins that example so the exclusion has a named, checkable reason rather than a silent one.
 *
 * ---- Watched red -------------------------------------------------------------------------------
 *
 * Before being kept, `amountCents: 1` was added to the `data:` of a real, non-allowlisted
 * `updateMany` call in application code and the suite was run: the "never sets amountCents"
 * assertion failed and named that exact file and line. The edit was then reverted byte-for-byte
 * and the suite re-run green. See this chantier's report for the verbatim failure output.
 */

// The single module allowed to set `amountCents` on an existing Transaction row: it is the write
// path that already re-reads the parent's amountCents inside the same transaction and refuses a
// split whose parts do not sum to it, so it is the one place a write to an existing row's amount
// could be paired with re-validating the invariant that write would otherwise threaten.
const ALLOWED_WRITER = join('src', 'lib', 'server', 'transactions', 'splits.ts');

// Helper functions whose return value is trusted, by name, to never touch `amountCents` — because
// each one has actually been read, not assumed. Used either as the whole `data:`/`update:` value
// (`data: manualCategoryUpdate(x)`) or spread into a literal object
// (`data: { ...manualCategoryUpdate(x), other: y }`). A name reaching this scan that is NOT in
// this set is reported by the "unresolvable" or "spreads only audited helpers" test below, by file
// and line, rather than silently passed.
const KNOWN_SAFE_DATA_HELPERS: ReadonlySet<string> = new Set([
	// src/lib/server/transactions/manualCategory.ts — returns exactly
	// `{ manualCategory, manualCategoryKey }`, read in full; does not mention `amountCents`.
	'manualCategoryUpdate'
]);

const GENERATED_PRISMA_CLIENT = join('src', 'lib', 'server', 'database', 'generated');

function isTestOnlyFile(path: string): boolean {
	return path.endsWith('.spec.ts') || path.endsWith('.db-smoke.ts');
}

function sourceFilesUnder(root: string, extensions: readonly string[]): string[] {
	return readdirSync(root, { recursive: true, encoding: 'utf8' })
		.map((entry) => join(root, entry))
		.filter((path) => extensions.some((ext) => path.endsWith(ext)))
		.filter((path) => !path.includes(GENERATED_PRISMA_CLIENT));
}

// prisma/ is deliberately absent: it holds no `.ts`/`.mjs` code, only `.prisma` schema text and
// generated SQL migrations (see the docstring above).
function allSourceFiles(): string[] {
	return [
		...sourceFilesUnder('src', ['.ts']),
		...sourceFilesUnder('e2e', ['.ts']),
		...sourceFilesUnder('scripts', ['.mjs'])
	];
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * Returns the index of the bracket matching the opener at `openIndex`, or -1 if the source ends
 * before one is found (malformed input). `'...'`, `"..."`, and `` `...` `` are treated as opaque
 * spans; `//` and `/* *‍/` comments are skipped. See the file docstring's blind-spot list for what
 * this deliberately does not handle.
 */
function matchingBracket(source: string, openIndex: number): number {
	const open = source[openIndex];
	const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : null;
	if (!close) throw new Error(`not an opening bracket at index ${openIndex}: ${open}`);
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		const c = source[i];
		if (c === '/' && source[i + 1] === '/') {
			const newline = source.indexOf('\n', i);
			if (newline === -1) return -1;
			i = newline;
			continue;
		}
		if (c === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			if (end === -1) return -1;
			i = end + 1;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			i++;
			while (i < source.length && source[i] !== quote) {
				if (source[i] === '\\') i++;
				i++;
			}
			continue;
		}
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Returns the index of the first top-level `,` in `text` at or after `from`, or the index of the
 * enclosing object's own closing bracket if none precedes it — i.e., the end of a field's value
 * expression, whichever comes first. Same string/comment handling as `matchingBracket`.
 */
function endOfValue(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === '/' && text[i + 1] === '/') {
			const newline = text.indexOf('\n', i);
			if (newline === -1) return text.length;
			i = newline;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end === -1) return text.length;
			i = end + 1;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			i++;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === '\\') i++;
				i++;
			}
			continue;
		}
		if (c === '(' || c === '{' || c === '[') depth++;
		else if (c === ')' || c === '}' || c === ']') {
			if (depth === 0) return i;
			depth--;
		} else if (c === ',' && depth === 0) return i;
	}
	return text.length;
}

type WriteMethod = 'update' | 'updateMany' | 'upsert';

interface CallSite {
	file: string;
	line: number;
	method: WriteMethod;
	argText: string;
}

// `<word>.transaction.update(` / `.updateMany(` / `.upsert(` — see blind spot 2 in the docstring
// for what a destructured client would evade.
const CALL_SITE = /\b\w+\.transaction\.(update|updateMany|upsert)\s*\(/g;

function findCallSites(file: string, source: string): CallSite[] {
	const sites: CallSite[] = [];
	CALL_SITE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CALL_SITE.exec(source))) {
		const method = match[1] as WriteMethod;
		const openParen = match.index + match[0].length - 1;
		const closeParen = matchingBracket(source, openParen);
		if (closeParen === -1) {
			throw new Error(
				`${file}:${lineOf(source, match.index)}: could not find the closing ")" for a ` +
					`transaction.${method}(...) call — the bracket-matching scan cannot read this file`
			);
		}
		sites.push({
			file,
			line: lineOf(source, match.index),
			method,
			argText: source.slice(openParen + 1, closeParen)
		});
	}
	return sites;
}

// `update`/`updateMany` touch an existing row through `data:`. `upsert`'s `create:` branch makes a
// NEW row and is out of scope by design (see the docstring); only its `update:` branch is in scope.
const KEY_FOR_METHOD: Record<WriteMethod, 'data' | 'update'> = {
	update: 'data',
	updateMany: 'data',
	upsert: 'update'
};

const DIRECT_HELPER_CALL = /^([A-Za-z_$][\w$]*)\s*\(/;

interface Inspection {
	site: CallSite;
	writesAmountCents: boolean;
	unresolvable: boolean;
	reason?: string;
	spreadHelpers: string[];
}

function inspect(site: CallSite): Inspection {
	const key = KEY_FOR_METHOD[site.method];
	const keyMatch = new RegExp(`\\b${key}\\s*:\\s*`).exec(site.argText);
	if (!keyMatch) {
		return {
			site,
			writesAmountCents: false,
			unresolvable: true,
			reason: `no "${key}:" key found in the call's argument`,
			spreadHelpers: []
		};
	}

	const valueStart = keyMatch.index + keyMatch[0].length;
	if (site.argText[valueStart] === '{') {
		const braceClose = matchingBracket(site.argText, valueStart);
		const body = site.argText.slice(valueStart, braceClose + 1);
		return {
			site,
			writesAmountCents: /\bamountCents\s*:/.test(body),
			unresolvable: false,
			spreadHelpers: [...body.matchAll(/\.\.\.(\w+)\s*\(/g)].map((m) => m[1])
		};
	}

	// Not a literal object: the whole `data:`/`update:` value is some other expression, most
	// plausibly a call to a helper that builds the fragment. See blind spot 3.
	const valueEnd = endOfValue(site.argText, valueStart);
	const valueExpr = site.argText.slice(valueStart, valueEnd).trim();
	const helperCall = DIRECT_HELPER_CALL.exec(valueExpr);
	if (helperCall && KNOWN_SAFE_DATA_HELPERS.has(helperCall[1])) {
		return { site, writesAmountCents: false, unresolvable: false, spreadHelpers: [] };
	}

	return {
		site,
		writesAmountCents: false,
		unresolvable: true,
		reason: `"${key}:" is neither a literal object nor a call to a known-safe helper: ${valueExpr.slice(0, 80)}`,
		spreadHelpers: []
	};
}

const productionFiles = allSourceFiles().filter((path) => !isTestOnlyFile(path));
const productionCallSites = productionFiles.flatMap((file) =>
	findCallSites(file, readFileSync(file, 'utf8'))
);

describe('amountCents is never written onto an existing Transaction row (except splits.ts)', () => {
	it('finds a plausible number of transaction.update/updateMany/upsert call sites', () => {
		// Guards the two regexes above (CALL_SITE and the key-detection regex built from
		// KEY_FOR_METHOD): if either stopped matching — a Prisma API rename, a call style this
		// pattern does not expect — every assertion below would pass vacuously because there would
		// be nothing left to check. 14 exist in production files as of this writing; asserting a
		// floor rather than the exact count so ordinary refactoring does not make this fragile.
		expect(productionCallSites.length).toBeGreaterThanOrEqual(10);
	});

	it('never sets amountCents in data/update on an existing row, outside the allowed writer', () => {
		const offenders = productionCallSites
			.filter((site) => site.file !== ALLOWED_WRITER)
			.map((site) => ({ site, inspection: inspect(site) }))
			.filter(({ inspection }) => inspection.writesAmountCents)
			.map(({ site }) => `${site.file}:${site.line} (${site.method})`);

		expect(offenders).toEqual([]);
	});

	it('has no update/upsert argument this scan cannot open as a literal object or a known-safe helper call', () => {
		const unresolved = productionCallSites
			.filter((site) => site.file !== ALLOWED_WRITER)
			.map(inspect)
			.filter((inspection) => inspection.unresolvable)
			.map(({ site, reason }) => `${site.file}:${site.line} (${site.method}) — ${reason}`);

		expect(unresolved).toEqual([]);
	});

	it('spreads only pre-audited helpers into a data/update object on an existing row', () => {
		const unaudited = productionCallSites
			.map(inspect)
			.flatMap(({ site, spreadHelpers }) => spreadHelpers.map((name) => ({ site, name })))
			.filter(({ name }) => !KNOWN_SAFE_DATA_HELPERS.has(name))
			.map(({ site, name }) => `${site.file}:${site.line} spreads ${name}(...)`);

		expect(unaudited).toEqual([]);
	});

	it('excludes db-smoke files from the production scan for a stated, checkable reason', () => {
		// The concrete example the docstring cites: a deliberate, documented drift of an existing
		// row's amount, written to prove the remainder algorithm rather than to perform a real
		// write. Pinned against the file's actual text so this exclusion cannot go stale silently —
		// if the example is ever removed, this fails and the exclusion's justification needs a new
		// example or needs re-examining.
		const example = join('src', 'lib', 'server', 'transactions', 'allocation.db-smoke.ts');
		expect(readFileSync(example, 'utf8')).toContain('amountCents: -6_000');
		expect(productionFiles).not.toContain(example);
	});

	it('has no raw SQL execution anywhere in production code, which this scan could not read', () => {
		// The scan reads Prisma call sites. A `$executeRaw`/`$executeRawUnsafe` writing an UPDATE by
		// hand would be completely invisible to it, and on a three-provider install raw SQL is exactly
		// where a one-off correction would be written. There is none today — every raw call in the
		// repo is a `$queryRaw` for advisory locks or a privilege probe, neither of which writes — so
		// this pins the absence rather than describing it in prose that would quietly go stale.
		// If this ever fails, the answer is not to widen the allowlist: it is to read the new raw
		// statement and decide whether the sum invariant survives it.
		const rawWriters = productionFiles
			.map((file) => ({ file, source: readFileSync(file, 'utf8') }))
			.filter(({ source }) => /\$executeRaw(Unsafe)?\b/.test(source))
			.map(({ file }) => file);

		expect(rawWriters).toEqual([]);
	});

	it('still has exactly the one allowed writer, and that file still exists', () => {
		// Guards ALLOWED_WRITER going stale (a rename this spec was not updated for), which would
		// silently make the exclusion above match nothing rather than the intended file.
		expect(readFileSync(ALLOWED_WRITER, 'utf8')).toContain('THE INVARIANT');
	});
});
