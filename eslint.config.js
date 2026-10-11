import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

const LOGGING_IMPORT_RESTRICTION = {
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
			message: 'Import log() from $lib/server/logging; a second writer starts its own chain.'
		}
	]
};

/**
 * THE MODEL DOOR (#535), CLOSED IN 1.3 (decision record #1009). The dashboard advice that called the
 * model was removed (#1010); the connection in `insights/local-llm.ts` is kept as a library with no
 * caller. So nothing under `src/` imports that module at all, and the refusal is the whole module
 * rather than a list of its exports: a list goes stale silently the day an export is renamed, and
 * ESLint does not report an entry that matches nothing. The next caller is added here by name, with
 * the admission that bounds it. `modelDoor.spec.ts` lints planted imports against this config.
 *
 * The model client itself, any entry point of the package (`ollama/browser` carries the full client
 * too): only `insights/local-llm.ts` holds one (#535, narrow pass F5).
 */
const MODEL_CLIENT = {
	group: ['ollama', 'ollama/*'],
	message: 'Only $lib/server/insights/local-llm.ts holds the model client (#535).'
};

/** `import()` is invisible to no-restricted-imports; a template literal hides its source from both. */
const MODEL_DOOR_DYNAMIC = [
	{
		selector: 'ImportExpression[source.value=/local-llm|^ollama(\\/|$)/]',
		message: 'Nothing reaches the model in 1.3 (#1009), and not through import().'
	},
	{
		selector: "ImportExpression[source.type='TemplateLiteral']",
		message: 'Spell an import() source as a plain string, so the model door (#535) can read it.'
	}
];

const MODEL_DOOR = {
	group: [
		'**/insights/local-llm',
		'**/local-llm',
		'**/local-llm.*',
		'$lib/server/insights/local-llm'
	],
	message:
		'Nothing calls the model in 1.3 (#1009): no file imports insights/local-llm. A caller is added to eslint.config.js by name, with its admission (#535).'
};

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
				...MODEL_DOOR_DYNAMIC,
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
					paths: LOGGING_IMPORT_RESTRICTION.paths,
					patterns: [...LOGGING_IMPORT_RESTRICTION.patterns, MODEL_CLIENT, MODEL_DOOR]
				}
			]
		}
	},
	{
		// The model client's one holder (#535).
		files: ['src/lib/server/insights/local-llm.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: LOGGING_IMPORT_RESTRICTION.paths,
					patterns: [...LOGGING_IMPORT_RESTRICTION.patterns, MODEL_DOOR]
				}
			]
		}
	},
	{
		// The model door outside src/lib/server too (#535, narrow pass F5): a module under src/lib
		// that a route imports is as close to the model as the route itself. Route components and the
		// universal and client hooks too (#1010): `ollama/browser` would call the model from the
		// member's browser, which no server-side door sees.
		files: [
			'src/lib/**/*.{ts,js,svelte}',
			'src/routes/**/*.svelte',
			'src/hooks.ts',
			'src/hooks.client.ts'
		],
		ignores: ['src/lib/server/**', '**/*.spec.ts', '**/*.svelte.spec.ts'],
		rules: {
			'no-restricted-imports': ['error', { patterns: [MODEL_CLIENT, MODEL_DOOR] }],
			'no-restricted-syntax': ['error', ...MODEL_DOOR_DYNAMIC]
		}
	},
	{
		// The writer itself configures pino and owns the core; boot.mjs runs before the bundle exists
		// and imports the core as TypeScript source, which is the one other place allowed to.
		files: ['src/lib/server/logging/**/*.ts'],
		// The logging restriction is lifted for the writer, the model door is not (#1010).
		rules: { 'no-restricted-imports': ['error', { patterns: [MODEL_CLIENT, MODEL_DOOR] }] }
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
