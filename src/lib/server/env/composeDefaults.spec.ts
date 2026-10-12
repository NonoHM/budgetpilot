import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from './settings';

/**
 * A SETTING READ BY DOCKER COMPOSE HAS ITS DEFAULT WRITTEN TWICE: once in the registry, which the
 * configuration reference renders, and once in each `${NAME:-default}` of a Compose file, which is
 * what an operator who sets nothing actually runs. Nothing else compares the two (#821 added two
 * such settings, `BP_OLLAMA_MEM_LIMIT` and `BP_OLLAMA_PIDS_LIMIT`, and the owner ruled they stay
 * Compose-read with this check beside them).
 *
 * Compose cannot refuse a value or warn at boot, so the registry's range is documentation only for
 * these; that limit is the owner's ruling on #821, not something this file can close.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const COMPOSE_FILES = execFileSync('git', ['ls-files', 'docker-compose*.yml'], {
	cwd: REPO_ROOT,
	encoding: 'utf8'
})
	.split('\n')
	.filter(Boolean);

const COMPOSE_READ = Object.entries(SETTINGS)
	.filter(([, setting]) => setting.readBy === 'compose')
	.map(([name]) => name);

/** Every `${NAME:-value}` default on an uncommented line, as `file:line value`. */
function composeDefaults(name: string): { where: string; value: string }[] {
	const pattern = new RegExp(`\\$\\{${name}:-([^}$]*)\\}`, 'g');
	return COMPOSE_FILES.flatMap((file) =>
		readFileSync(REPO_ROOT + file, 'utf8')
			.split('\n')
			.flatMap((line, index) =>
				line.trimStart().startsWith('#')
					? []
					: [...line.matchAll(pattern)].map((match) => ({
							where: `${file}:${index + 1}`,
							value: match[1]
						}))
			)
	);
}

/** The registry default of a setting, or undefined when it has none (a required one). */
function registryDefault(name: string): string | undefined {
	const setting = SETTINGS[name as keyof typeof SETTINGS];
	return 'default' in setting ? String(setting.default) : undefined;
}

const WITH_DEFAULT = COMPOSE_READ.filter((name) => registryDefault(name) !== undefined);
const WITHOUT_DEFAULT = COMPOSE_READ.filter((name) => !WITH_DEFAULT.includes(name));

describe('Compose-read settings', () => {
	it('reads the Compose files and finds the settings, so an empty read cannot pass', () => {
		// Absolute figures: a glob that matched nothing, or a registry that lost its Compose-read
		// entries, would satisfy the comparisons below with nothing compared.
		expect({
			files: COMPOSE_FILES.length,
			withDefault: WITH_DEFAULT,
			withoutDefault: WITHOUT_DEFAULT
		}).toStrictEqual({
			files: 9,
			withDefault: ['APP_PORT', 'BP_OLLAMA_MEM_LIMIT', 'BP_OLLAMA_PIDS_LIMIT'],
			withoutDefault: ['DATABASE_PASSWORD']
		});
	});

	it.each(WITH_DEFAULT)(
		'%s carries the registry default in every Compose file that reads it',
		(name) => {
			const found = composeDefaults(name);
			const registry = registryDefault(name);
			expect(
				found.length,
				`${name} has no \${${name}:-...} default in any Compose file`
			).toBeGreaterThan(0);
			expect(found.filter(({ value }) => value !== registry)).toStrictEqual([]);
		}
	);

	// A required setting (`${NAME:?message}`) given a fallback in some file would start that stack
	// with a value the registry says does not exist.
	it.each(WITHOUT_DEFAULT)('%s has no default in any Compose file', (name) => {
		expect(composeDefaults(name)).toStrictEqual([]);
	});
});
