import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * An install's Compose files are named once, in the `COMPOSE_FILE` line of its `.env` (#1030).
 *
 * Every command a reader copies is plain `docker compose`. A `-f` REPLACES that list rather than
 * adding to it, so `docker compose -f docker-compose.prebuilt.yml up -d`, copied from « Updating »
 * by an operator on the PostgreSQL overlay, recreated the app on the base file's SQLite default:
 * an empty instance, the database container left running as an orphan. Measured with
 * `docker compose config` on Compose 5.5.1: the line in `.env` alone gives
 * `DATABASE_URL=postgresql…`, the same `.env` plus that `-f` gives `file:…`. An EXPORTED
 * `COMPOSE_FILE` wins over `.env` the same way, and these pages used to tell readers to export the
 * base file alone, so that form is refused too, as is the one-command `COMPOSE_FILE=… docker`.
 *
 * WHAT THIS READS: README.md, every tracked docs/**.md, and the comments of every
 * docker-compose*.yml, which are where an operator copies commands from. `scripts/` is not read:
 * those commands run from our own tooling against a fixed list of files, never pasted.
 *
 * WHAT IT CANNOT SEE: prose that asks for a flag without naming a Compose file after it
 * (« pass both `-f` options »), which reading the page has to catch; options that change which
 * `.env` or project is read (`--env-file`, `--project-directory`, `-p`), none of which a page here
 * uses; a file named through a variable (`-f $DIR/x.yml`); and a page outside the repository.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Third-party texts copied byte for byte, and release-please's file built from commit bodies. */
const EXCLUDED = ['docs/reference/standards/', 'CHANGELOG.md'];

/**
 * The three forms, each a way to name files somewhere other than the `.env` line.
 * 1. `-f` or `--file` followed by a YAML file name, as a command or in prose, across a line break.
 *    `logs -f budgetpilot` follows logs and names no YAML file, so it is not matched.
 * 2. An exported `COMPOSE_FILE`, which beats `.env` in every later command of that shell.
 * 3. `COMPOSE_FILE=… docker`, the same override for one command.
 */
const NAMED_FILE_FORMS = [
	/(?<![\w-])(?:-f|--file)(?:\s+|=)[`'"]?[\w./-]+\.ya?ml\b/g,
	/\bexport\s+COMPOSE_FILE\b/g,
	/\bCOMPOSE_FILE=\S*\s+docker\b/g
];

function readTargets(): string[] {
	const listed = execFileSync(
		'git',
		['ls-files', 'README.md', 'docs/*.md', 'docker-compose*.yml'],
		{
			cwd: REPO_ROOT,
			encoding: 'utf8'
		}
	);
	return listed
		.split('\n')
		.filter(Boolean)
		.filter((path) => !EXCLUDED.some((prefix) => path.startsWith(prefix)));
}

function namedFiles(text: string): { line: number; text: string }[] {
	return NAMED_FILE_FORMS.flatMap((form) =>
		[...text.matchAll(form)].map((match) => ({
			line: text.slice(0, match.index).split('\n').length,
			text: match[0].replace(/\s+/g, ' ')
		}))
	);
}

describe('operator pages name Compose files only in the .env line (#1030)', () => {
	it('reads the README, the docs and every Compose file, so a clean result cannot mean an empty list', () => {
		const targets = readTargets();
		expect(targets).toContain('README.md');
		expect(targets).toContain('docs/operations.md');
		expect(
			targets.filter((path) => path.startsWith('docker-compose')).length
		).toBeGreaterThanOrEqual(9);
		expect(targets.length).toBeGreaterThan(30);
	});

	it('finds each form these pages have carried, and nothing in a follow flag or in the .env line', () => {
		// Positives, one per form these pages carried on main when this was written.
		expect(namedFiles('docker compose -f docker-compose.prebuilt.yml pull')).toHaveLength(1);
		expect(namedFiles('docker compose -f a.yml \\\n  -f docker-compose.proxy.yml up -d')).toEqual([
			{ line: 1, text: '-f a.yml' },
			{ line: 2, text: '-f docker-compose.proxy.yml' }
		]);
		expect(namedFiles('#   docker compose --file=docker-compose.yml up -d')).toHaveLength(1);
		expect(namedFiles('add `-f docker-compose.prebuilt.yml` to each command')).toHaveLength(1);
		expect(namedFiles('export COMPOSE_FILE=docker-compose.prebuilt.yml')).toHaveLength(1);
		expect(namedFiles('COMPOSE_FILE=a.yml:b.yml docker compose up -d')).toHaveLength(1);
		// Negatives: following logs, the line itself in `.env`, and prose naming the variable.
		expect(namedFiles('docker compose logs -f budgetpilot')).toEqual([]);
		expect(namedFiles('COMPOSE_FILE=docker-compose.prebuilt.yml:docker-compose.ai.yml\n')).toEqual(
			[]
		);
		expect(namedFiles('if you ever ran `unset COMPOSE_FILE`, a `-f` flag replaces it')).toEqual([]);
	});

	it('finds no page that names a Compose file outside the .env line', () => {
		const offenders = readTargets().flatMap((path) =>
			namedFiles(readFileSync(`${REPO_ROOT}${path}`, 'utf8')).map(
				({ line, text }) => `${path}:${line}  ${text}`
			)
		);
		// Put the file in the `COMPOSE_FILE` line of `.env` instead, then use plain `docker compose`.
		// docs/operations.md, top of the page, is the one explanation of that line.
		expect(offenders).toEqual([]);
	});

	it('writes the line in the one .env block both install pages carry, and only for the published image', () => {
		// A fresh install gets the line from this block, and the block exists twice, kept by hand. The
		// condition matters as much as the line: a source checkout given the prebuilt line would run
		// the published image under `up -d --build` and stop loading its override file. Executed in
		// bash and zsh when this was written: 7 lines in a prebuilt folder, 6 in a checkout.
		const envBlock = (path: string, after: string) => {
			const text = readFileSync(`${REPO_ROOT}${path}`, 'utf8');
			const start = text.indexOf('```bash\n', text.indexOf(after));
			return text.slice(start, text.indexOf('\n```\n', start));
		};
		const readme = envBlock('README.md', 'Create your `.env`');
		const guide = envBlock('docs/getting-started.md', '### 2. Create your `.env`');
		expect(readme).toContain('umask 077');
		expect(guide).toBe(readme);
		expect(readme).toContain(
			"{ [ -e docker-compose.yml ] || echo 'COMPOSE_FILE=docker-compose.prebuilt.yml' >> .env; }"
		);
		expect(readme).toMatch(/^COMPOSE_PATH_SEPARATOR=:$/m);
	});
});
