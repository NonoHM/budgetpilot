import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// The log has one writer (#250): `log(event)` in src/lib/server/logging, whose events are a
		// closed type escaped on the way out. A bare console call, or a write to stdout or stderr,
		// in server code would put a line in the log that bypasses the type, the escaping and the
		// secret scan's assumptions. Specs, db-smoke files and the Enable Banking sandbox script are
		// test code and are not shipped. `scripts/` and `boot.mjs` are outside these globs: the
		// first are operator CLIs, the second writes through the logger's own core.
		files: ['src/lib/server/**/*.{ts,js}', 'src/routes/**/*.{ts,js}', 'src/hooks.server.ts'],
		ignores: ['**/*.spec.ts', '**/*.db-smoke.ts', '**/*.sandbox-validation.ts'],
		rules: {
			'no-console': 'error',
			'no-restricted-properties': [
				'error',
				{
					object: 'process',
					property: 'stdout',
					message: 'Write the log through log(event) in $lib/server/logging.'
				},
				{
					object: 'process',
					property: 'stderr',
					message: 'Write the log through log(event) in $lib/server/logging.'
				}
			],
			'no-restricted-imports': [
				'error',
				{
					paths: [{ name: 'pino', message: 'Only src/lib/server/logging configures the writer.' }]
				}
			]
		}
	},
	{
		files: ['src/lib/server/logging/**/*.ts'],
		rules: { 'no-restricted-imports': 'off' }
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {
			// Convention: a leading underscore marks an intentionally unused binding
			// (e.g. `{#each list as _, i}` when only the index is needed).
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	}
);
