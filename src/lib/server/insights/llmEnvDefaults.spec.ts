import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_LLM_ENV_DEFAULTS } from './local-llm';

/**
 * THE THREE PLACES AN LLM DEFAULT IS WRITTEN MUST AGREE, and this file is the only thing that
 * checks it.
 *
 * #524 was not a wrong number. It was three copies of a number and no comparison. `LLM_TIMEOUT_MS`
 * read 45000 in `local-llm.ts`, 45000 in `.env.example` and 10000 in `docker-compose.ai.yml`, and
 * the overlay is the ONLY file in the tree that runs Ollama in Docker, so the stale copy was the
 * one every Docker operator actually ran. A cold model load was aborted at 10 s and the dashboard
 * reported the assistant as unavailable.
 *
 * The divergence was introduced by #59 — the fix for that same bug, which raised the two copies it
 * could see and left the third. It survived thirteen months because the overlay carried a comment
 * saying "Defaults mirror .env.example", which was true when written and which nothing re-reads.
 * CLAUDE.md's rule for exactly this: notice when a figure is being asked to do a check's job, and
 * move it into a test.
 *
 * WHY THE PREBUILT PATH IS THE ONE THAT BREAKS, since it is not obvious that a `${VAR:-default}`
 * ever applies. `docker compose` interpolates from the project's `.env`, so an operator who copied
 * `.env.example` gets its value and never sees the overlay's. The prebuilt flow does not copy it:
 * `docs/getting-started.md` writes a five-line `.env` carrying secrets, a version and a port, so
 * every LLM variable falls through to the overlay's default. That is the documented path, and it is
 * the one this test protects.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** The variables this test is responsible for, named rather than discovered. */
const GUARDED = Object.keys(LOCAL_LLM_ENV_DEFAULTS) as (keyof typeof LOCAL_LLM_ENV_DEFAULTS)[];

function readRepoFile(relativePath: string): string {
	const contents = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
	// A path that moved would otherwise read as "no variables found", which is the confident zero
	// this repository keeps paying for: an empty parse and a clean comparison are the same green.
	expect(contents.length).toBeGreaterThan(0);
	return contents;
}

/** `LLM_TIMEOUT_MS=45000` in a dotenv file, ignoring comment lines. */
function readEnvExampleValue(contents: string, name: string): number | null {
	const match = new RegExp(`^${name}=(\\d+)\\s*$`, 'm').exec(contents);
	return match ? Number(match[1]) : null;
}

/** `LLM_TIMEOUT_MS: ${LLM_TIMEOUT_MS:-45000}` in the Compose overlay, ignoring comment lines. */
function readComposeDefault(contents: string, name: string): number | null {
	const match = new RegExp(`^\\s*${name}:\\s*\\$\\{${name}:-(\\d+)\\}\\s*$`, 'm').exec(contents);
	return match ? Number(match[1]) : null;
}

describe('LLM environment defaults', () => {
	it('names at least one variable to guard, so an empty list cannot report a clean run', () => {
		// Separates "every guarded variable agrees" from "no variable was guarded". Those produce the
		// identical green in the test below, and only this assertion tells them apart. The figure is
		// absolute rather than `> 0` so that dropping a variable from the code defaults is a failure
		// here rather than a silent narrowing of what the next test covers.
		expect(GUARDED).toEqual(['LLM_TIMEOUT_MS', 'LLM_CONNECT_TIMEOUT_MS']);
	});

	it.each(GUARDED)(
		'%s carries the same default in the code, .env.example and docker-compose.ai.yml',
		(name) => {
			const envExample = readEnvExampleValue(readRepoFile('.env.example'), name);
			const compose = readComposeDefault(readRepoFile('docker-compose.ai.yml'), name);

			// Asserted before the comparison, and separately: a regex that matched nothing returns null
			// on both sides, and `null === null` is a passing comparison that has read no value at all.
			// This is the same failure shape as the sweep that reported zero because its path did not
			// exist. Naming the source in the message is what makes a red here diagnosable.
			expect(envExample, `${name} not found in .env.example`).not.toBeNull();
			expect(compose, `${name} not found in docker-compose.ai.yml`).not.toBeNull();

			expect(envExample).toBe(LOCAL_LLM_ENV_DEFAULTS[name]);
			expect(compose).toBe(LOCAL_LLM_ENV_DEFAULTS[name]);
		}
	);

	it('reproduces #524: the overlay default is no longer the 10000 that aborted a cold load', () => {
		// The original measurement, per AGENTS.md ("on a defect the red must bring back the original
		// value"). Ollama logged `499 after 10.285320802s` with "client connection closed before
		// llama-server finished loading", which is this number and no other.
		const compose = readComposeDefault(readRepoFile('docker-compose.ai.yml'), 'LLM_TIMEOUT_MS');
		expect(compose).not.toBe(10_000);
		expect(compose).toBe(45_000);
	});
});
