import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { renderSettingsReference } from './settingsReference';
import { SETTINGS } from './settings';

const PAGE = '../../../../docs/configuration-reference.md';

/**
 * The rendering as it is committed: through prettier with the repository's own configuration, so
 * the page is both the registry's output and prettier-clean, and `lint:tracked` and this gate can
 * never ask for two different files.
 */
async function formattedPage(): Promise<string> {
	const filepath = fileURLToPath(new URL(PAGE, import.meta.url));
	const options = await prettier.resolveConfig(filepath);
	return prettier.format(renderSettingsReference(), { ...options, filepath });
}

/**
 * The committed reference page IS the registry's rendering (R14). `toMatchFileSnapshot` fails in
 * CI on any difference and never writes there; locally, `-u` rewrites the page from the registry.
 *
 * Break-checked: a registry summary edited without regenerating (the page in step with the
 * registry versus behind it) reddens on the changed row.
 */
describe('docs/configuration-reference.md', () => {
	it('is the rendering of the settings registry', async () => {
		await expect(await formattedPage()).toMatchFileSnapshot(PAGE);
	});

	// The calibration for the snapshot: a renderer that dropped rows would still match a page
	// regenerated from it. Every registered name must appear as a row.
	it('has a row for every registered setting', () => {
		const page = renderSettingsReference();
		const missing = Object.keys(SETTINGS).filter((name) => !page.includes(`| \`${name}\` |`));
		expect({ settings: Object.keys(SETTINGS).length, missing }).toStrictEqual({
			settings: 44,
			missing: []
		});
	});
});
