import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for a hard design constraint (tags design spec, section 6.6/6.7 and
// CLAUDE.md's binding "faire du complexe simple" maxim): tag CREATION must never exist in
// Settings. A tag is created only by typing a name on a transaction. Adding a "New tag" button
// or a `?/createTag` action here would reintroduce the second taxonomy the design forbids.
//
// String-based, like button-tone-convention.spec.ts in this same directory: the property under
// test is "which affordances exist in the source", not runtime behaviour, so mounting the full
// page is unnecessary weight for what this checks.

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const settingsPage = readFileSync(resolve(root, 'src/routes/settings/+page.svelte'), 'utf8');
const settingsServer = readFileSync(resolve(root, 'src/routes/settings/+page.server.ts'), 'utf8');

describe('settings tag section has no creation affordance', () => {
	it('defines no ?/createTag action on the server', () => {
		expect.assertions(1);

		expect(settingsServer).not.toMatch(/createTag/);
	});

	it('renders no createTag form action in the markup', () => {
		expect.assertions(1);

		expect(settingsPage).not.toContain('?/createTag');
	});

	it("the tag section's empty state has no call to action", () => {
		expect.assertions(3);

		// Isolate the tag section's markup so an unrelated ctaLabel/onCtaClick elsewhere on the
		// page (e.g. /categories' own empty state, a different file entirely) can never make this
		// pass for the wrong reason.
		const sectionStart = settingsPage.indexOf('<!-- ÉTIQUETTES -->');
		const sectionEnd = settingsPage.indexOf('<!-- ZONE DANGER -->');
		expect(sectionStart).toBeGreaterThan(-1);
		expect(sectionEnd).toBeGreaterThan(sectionStart);

		const tagSection = settingsPage.slice(sectionStart, sectionEnd);
		expect(tagSection).not.toMatch(/ctaLabel|onCtaClick|ctaHref/);
	});
});
