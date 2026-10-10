import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '$lib/server/env/settings';
import { localLlmModel } from '$lib/server/insights/local-llm';
import qualified from './qualified-model.json';

/**
 * THE DEFAULT MODEL IS WRITTEN ONCE, in `qualified-model.json`, beside the digest it was qualified
 * at (#971). The code reads it; the files that cannot import it (a dotenv example, the Compose
 * overlay, the pages an operator copies a command from) are checked against it here,
 * each at the one place it names the default.
 *
 * `scripts/test-env.sh` is deliberately NOT a copy: a throwaway environment pulls a small model on
 * purpose, and its header says why.
 *
 * #524 is the reason the comparison is per FILE and not a search for the old tag: three copies of
 * one default, and the stale one was the one every Docker operator ran.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

function read(relativePath: string): string {
	const contents = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
	expect(contents.length, relativePath).toBeGreaterThan(0);
	return contents;
}

/** Each copy, with the one pattern that finds it. A pattern that matches nothing is a failure. */
const COPIES: { file: string; pattern: RegExp }[] = [
	{ file: '.env.example', pattern: /^LLM_MODEL=(\S+)\s*$/m },
	{ file: 'docker-compose.ai.yml', pattern: /LLM_MODEL: \$\{LLM_MODEL:-([^}]+)\}/ },
	{ file: 'docs/ai-insights.md', pattern: /exec ollama ollama pull (\S+)/ },
	{ file: 'docs/ai-insights.md', pattern: /They default to\s+`([^`]+)`/ },
	{ file: 'docs/reference/ai-model.md', pattern: /exec ollama ollama show (\S+)/ },
	{
		file: 'docs/reference/ai-model.md',
		pattern: /^## The qualified default[\s\S]*?^\| `([^`]+)` +\|/m
	},
	{ file: 'docs/ai-insights.md', pattern: /not installed until you pull\s+`([^`]+)`/ },
	{ file: 'docs/configuration-reference.md', pattern: /^\| `LLM_MODEL` +\|[^|]*\| (\S+) +\|/m }
];

describe('the qualified default model', () => {
	it('is a tag and a full digest', () => {
		expect(qualified.tag).toMatch(/^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/);
		expect(qualified.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is what the code asks for when LLM_MODEL is unset', () => {
		expect(SETTINGS.LLM_MODEL.default).toBe(qualified.tag);
		expect(localLlmModel({})).toBe(qualified.tag);
	});

	it.each(COPIES)('is the default $file names ($pattern)', ({ file, pattern }) => {
		const match = pattern.exec(read(file));
		expect(match, `${pattern} found nothing in ${file}`).not.toBeNull();
		expect(match![1]).toBe(qualified.tag);
	});

	it('is the digest the reference page prints beside it', () => {
		const row = /^## The qualified default[\s\S]*?^\| `[^`]+` +\| \S+ +\| `([0-9a-f]{12})`/m.exec(
			read('docs/reference/ai-model.md')
		);
		expect(row, 'the qualified-default table names a digest').not.toBeNull();
		expect(qualified.digest.startsWith(row![1])).toBe(true);
	});

	it('was qualified on the Ollama release the overlay and the weekly check both run', () => {
		const overlay = /image: ollama\/ollama:(\S+)/.exec(read('docker-compose.ai.yml'));
		const workflow = /OLLAMA_TAG: '([^']+)'/.exec(read('.github/workflows/ai-check.yml'));
		expect(overlay, 'the overlay names an Ollama tag').not.toBeNull();
		expect(workflow, 'the weekly check names an Ollama tag').not.toBeNull();
		expect(overlay![1]).toBe(qualified.ollama);
		expect(workflow![1]).toBe(qualified.ollama);
	});
});
