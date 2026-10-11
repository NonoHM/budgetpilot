import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * THE MODEL DOOR, LINTED (#535, closed in 1.3 by #1010). `eslint.config.js` refuses any import of
 * `insights/local-llm` and of the `ollama` client outside `local-llm.ts`. A lint rule nobody plants a
 * violation against is believed rather than measured, and the previous form of this door was a list
 * of export names that a rename would have emptied with lint still green. So each case below is a
 * planted import, linted with the repository's own config at a path the rule must cover, and the
 * calibration is the same client import at the one path allowed to hold it.
 */

const eslint = new ESLint({ cwd: process.cwd() });

/** The door's own messages for `code` linted as `filePath`: other rules (unused imports) are noise. */
async function doorMessages(code: string, filePath: string): Promise<string[]> {
	const [result] = await eslint.lintText(code, { filePath });
	// A parse failure reports no rule at all, so it would read as « the door raised nothing ». Typed
	// Svelte linting refuses a path its project does not hold, which is why components are planted at
	// a path that exists.
	const fatal = result.messages.filter((message) => message.fatal);
	if (fatal.length > 0) throw new Error(`${filePath} was not linted: ${fatal[0].message}`);
	return result.messages
		.filter(
			(message) =>
				message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax'
		)
		.map((message) => message.message);
}

const TRANSPORT = "import { requestLocalModel } from '$lib/server/insights/local-llm';\n";
const RENAMED = "import { anyNameAtAll } from '$lib/server/insights/local-llm';\n";
const RELATIVE = "import { probeLocalLlm } from '../insights/local-llm';\n";
const DYNAMIC = "export const load = () => import('$lib/server/insights/local-llm');\n";
const CLIENT = "import { Ollama } from 'ollama';\nexport const client = Ollama;\n";
const BROWSER_CLIENT = "import { Ollama } from 'ollama/browser';\nexport const client = Ollama;\n";

// no-restricted-imports prefixes its own sentence (« '<source>' import is restricted ... »).
const DOOR = /Nothing calls the model in 1\.3 \(#1009\)/;
const DOOR_DYNAMIC = /^Nothing reaches the model in 1\.3 \(#1009\), and not through import\(\)\./;
const HOLDER = /Only \$lib\/server\/insights\/local-llm\.ts holds the model client/;

describe('the model door (#535, #1010)', () => {
	it.each([
		['a route', 'src/routes/probe/+page.server.ts'],
		['a server module', 'src/lib/server/probe/door.ts'],
		['a module under src/lib outside server', 'src/lib/domain/doorProbe.ts'],
		[
			'the log writer, whose own import restriction is lifted',
			'src/lib/server/logging/doorProbe.ts'
		]
	])('refuses the transport imported from %s', async (_where, filePath) => {
		expect(await doorMessages(TRANSPORT, filePath)).toEqual([expect.stringMatching(DOOR)]);
	});

	it('refuses an export it has never heard of: the whole module is closed, not a list of names', async () => {
		expect(await doorMessages(RENAMED, 'src/routes/probe/+page.server.ts')).toEqual([
			expect.stringMatching(DOOR)
		]);
	});

	it('refuses a relative path to the module', async () => {
		expect(await doorMessages(RELATIVE, 'src/lib/server/probe/door.ts')).toEqual([
			expect.stringMatching(DOOR)
		]);
	});

	it('refuses the module through import()', async () => {
		expect(await doorMessages(DYNAMIC, 'src/routes/probe/+page.server.ts')).toEqual([
			expect.stringMatching(DOOR_DYNAMIC)
		]);
	});

	it.each([CLIENT, BROWSER_CLIENT])(
		'refuses the model client outside its holder: %s',
		async (code) => {
			expect(await doorMessages(code, 'src/lib/server/probe/door.ts')).toEqual([
				expect.stringMatching(HOLDER)
			]);
		}
	);

	it.each([
		[
			'a route component',
			'src/routes/+page.svelte',
			`<script lang="ts">\n${BROWSER_CLIENT}</script>\n`
		],
		['the client hooks', 'src/hooks.client.ts', BROWSER_CLIENT]
	])(
		'refuses the browser client in %s, where no server-side door sees it',
		async (_where, filePath, code) => {
			expect(await doorMessages(code, filePath)).toEqual([expect.stringMatching(HOLDER)]);
		}
	);

	it('calibration: the same client import at the holder raises nothing from the door', async () => {
		expect(await doorMessages(CLIENT, 'src/lib/server/insights/local-llm.ts')).toEqual([]);
	});
}, 60_000);
