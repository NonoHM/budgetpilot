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
		// closed type escaped on the way out. Anything else that reaches stdout or stderr from server
		// code would put a line in the log that bypasses the type, the escaping and the secret scan's
		// assumptions. Each rule below closes one way round it, and each was seen to fire on a planted
		// bypass (contradiction pass on L2): a console call or a console reference (aliasing it, or
		// reaching it through globalThis), a write to file descriptor 1 or 2, stdout or stderr taken
		// from the process object or imported from node:process, and the writer's core imported
		// directly, which would build a second chain with its own sequence. What no lint rule can see,
		// a dependency writing to process.stdout itself, is what the console bridge and the
		// injection probe are for. Specs, db-smoke files and the Enable Banking sandbox script are test
		// code and are not shipped; scripts/ holds operator CLIs whose output is their interface.
		files: [
			'src/lib/server/**/*.{ts,js}',
			'src/routes/**/*.{ts,js}',
			'src/hooks.server.ts',
			'boot.mjs'
		],
		ignores: ['**/*.spec.ts', '**/*.db-smoke.ts', '**/*.sandbox-validation.ts'],
		rules: {
			'no-console': 'error',
			'no-restricted-globals': [
				'error',
				{ name: 'console', message: 'Write the log through log(event) in $lib/server/logging.' }
			],
			'no-restricted-syntax': [
				'error',
				{
					selector: "MemberExpression[object.name='globalThis'][property.name='console']",
					message: 'Write the log through log(event) in $lib/server/logging.'
				},
				{
					selector: "CallExpression[callee.name='writeSync'][arguments.0.value=1]",
					message: 'File descriptor 1 is the log. Write it through log(event).'
				},
				{
					selector: "CallExpression[callee.name='writeSync'][arguments.0.value=2]",
					message: 'File descriptor 2 shares the log. Write it through log(event).'
				},
				{
					selector: "CallExpression[callee.property.name='writeSync'][arguments.0.value=1]",
					message: 'File descriptor 1 is the log. Write it through log(event).'
				},
				{
					selector: "CallExpression[callee.property.name='writeSync'][arguments.0.value=2]",
					message: 'File descriptor 2 shares the log. Write it through log(event).'
				}
			],
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
					paths: [
						{ name: 'pino', message: 'Only src/lib/server/logging configures the writer.' },
						{
							name: 'node:process',
							importNames: ['stdout', 'stderr'],
							message: 'Write the log through log(event) in $lib/server/logging.'
						},
						{
							name: 'process',
							importNames: ['stdout', 'stderr'],
							message: 'Write the log through log(event) in $lib/server/logging.'
						}
					],
					patterns: [
						{
							group: ['**/logging/core', '**/logging/core.ts', '$lib/server/logging/core'],
							message:
								'Import log() from $lib/server/logging; a second writer starts its own chain.'
						}
					]
				}
			]
		}
	},
	{
		// The writer itself configures pino and owns the core; boot.mjs runs before the bundle exists
		// and imports the core as TypeScript source, which is the one other place allowed to.
		files: ['src/lib/server/logging/**/*.ts'],
		rules: { 'no-restricted-imports': 'off' }
	},
	{
		files: ['boot.mjs'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{ name: 'pino', message: 'Only src/lib/server/logging configures the writer.' },
						{ name: 'node:process', importNames: ['stdout', 'stderr'] },
						{ name: 'process', importNames: ['stdout', 'stderr'] }
					]
				}
			]
		}
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
