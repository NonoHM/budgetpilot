#!/usr/bin/env node
/**
 * `npm run lint` over the TRACKED files only, which is the set a fresh clone has.
 *
 * ## Why this exists, measured rather than supposed
 *
 * `npm run lint` is `prettier --check . && eslint .`, and neither half runs in a working tree that
 * has registered git worktrees. `.claude/worktrees/` holds other branches' checkouts, so eslint
 * finds several candidate `tsconfigRootDir`s under the cwd and refuses to parse ANYTHING (~1720
 * parse errors, every file in `src/`, `e2e/` and `scripts/`), and prettier walks their generated
 * output. Both read exactly like a catastrophic regression and are a fact about the directory.
 *
 * The worktrees are not deletable: they are somebody else's work in progress, and AGENTS.md says so
 * by name. So the repair is to stop pointing the tools at the DIRECTORY and point them at the FILE
 * SET instead. `git ls-files` is that set, and a fresh clone is exactly it, which is what makes this
 * script CI-equivalent rather than merely narrower.
 *
 * CI caught three things this session that no local gate could see. Two of them were this.
 *
 * ## What is asserted before anything is believed
 *
 * Each leg refuses to run on an empty file list. A linter given no files exits 0, and an exit 0 that
 * means « nothing was read » prints identically to one that means « nothing was wrong »: that is the
 * harness that reported « nothing red » four times while every run died at startup. So each leg
 * prints how many files it read, and an empty list is a failure rather than a pass.
 *
 * Exit status is read from the child directly. Nothing is piped, and nothing greps the output: a
 * piped chain reports the LAST command's status, and a regex over colourised output reports a clean
 * run because the escape codes sit where the anchor was.
 *
 * ## What this is NOT
 *
 * It is not a replacement for CI. It covers the two lint legs and says nothing about `check`,
 * `build`, vitest or Playwright. It is the cheapest way to stop pushing red for a formatting slip.
 */
import { spawnSync } from 'node:child_process';

/** Extensions eslint's flat config actually has a parser for. Anything else it would refuse. */
const LINTABLE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.svelte']);

function tracked() {
	const ls = spawnSync('git', ['ls-files', '-z'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (ls.status !== 0) {
		throw new Error(`git ls-files failed (${ls.status}): ${ls.stderr}`);
	}
	const files = ls.stdout.split('\0').filter(Boolean);
	if (files.length === 0) {
		throw new Error('git ls-files returned nothing. Refusing to report a clean run over no files.');
	}
	return files;
}

/**
 * @param {string} name
 * @param {string[]} argv
 * @param {string[]} files
 */
function leg(name, argv, files) {
	if (files.length === 0) {
		console.error(
			`\n✗ ${name}: no files matched. A linter with no input exits 0 and means nothing.`
		);
		return false;
	}
	console.log(`\n▶ ${name}: ${files.length} tracked files`);
	const run = spawnSync('npx', [...argv, ...files], { stdio: 'inherit' });
	if (run.error) {
		throw run.error;
	}
	// A signal death carries a null status, and `null !== 0` would already be false-negative-proof,
	// but say which it was: a killed run is not a failing check.
	if (run.signal) {
		throw new Error(`${name} was killed by ${run.signal} before it could report.`);
	}
	const ok = run.status === 0;
	console.log(ok ? `✓ ${name}` : `✗ ${name} (exit ${run.status})`);
	return ok;
}

const files = tracked();

// `--ignore-unknown` is what makes an explicit file list behave like `prettier --check .`: the
// tracked set carries PNGs and lockfiles, and prettier given one by name errors « no parser » where
// the directory walk would simply have skipped it. `.prettierignore` is honoured either way.
const prettierOk = leg('prettier --check', ['prettier', '--check', '--ignore-unknown'], files);

const lintable = files.filter((f) => LINTABLE.has(f.slice(f.lastIndexOf('.'))));
// `--no-warn-ignored`: `.gitignore` is fed into the eslint config, so a tracked file that is also
// ignored there (there are none today, and that is not a property to rely on) would print a warning
// and exit 0. Suppressing it keeps the output about code.
const eslintOk = leg('eslint', ['eslint', '--no-warn-ignored'], lintable);

console.log('');
process.exit(prettierOk && eslintOk ? 0 : 1);
