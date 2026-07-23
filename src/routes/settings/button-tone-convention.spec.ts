import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for the repo's Button tone convention (see CLAUDE.md "UI/UX conventions"):
// a solid `danger` Button is reserved for the actual final destructive-confirmation submit.
// A button that merely *opens* a ConfirmDialog (the real destructive action happens inside the
// dialog itself) must use `ghost-danger` instead — string-based like dashboard-mode.spec.ts,
// since mounting the full settings +page.svelte requires a large PageData/session fixture for
// a check that's purely about which Button variant string sits next to which onclick handler.

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const settingsPage = readFileSync(resolve(root, 'src/routes/settings/+page.svelte'), 'utf8');

describe('settings +page.svelte button tone convention', () => {
	it('uses ghost-danger (not solid danger) for the two restore-backup trigger buttons', () => {
		expect.assertions(3);

		// Both trigger buttons (desktop + mobile) only open restoreConfirmOpen; the destructive
		// restore itself happens inside the ConfirmDialog's own submit.
		const triggerBlocks = settingsPage
			.split('onclick={() => (restoreConfirmOpen = true)}')
			.slice(0, -1);

		expect(triggerBlocks).toHaveLength(2);
		for (const block of triggerBlocks) {
			// Look backward from the onclick to the nearest <Button ...> opening tag.
			const buttonStart = block.lastIndexOf('<Button');
			const buttonTag = block.slice(buttonStart);
			expect(buttonTag).toContain('variant="ghost-danger"');
		}
	});

	it('keeps solid danger for the actual final destructive submits (delete account, MFA disable)', () => {
		expect.assertions(2);

		expect(settingsPage).toContain('{m.settings_delete_confirm_submit()}');
		// The delete-account submit button (gated by the typed "SUPPRIMER" confirmation) and the
		// MFA-disable submit button are themselves the final destructive action, not a dialog
		// trigger — they're allowed to stay solid `danger`.
		const deleteSubmitBlock = settingsPage.slice(
			settingsPage.lastIndexOf(
				'<Button',
				settingsPage.indexOf('{m.settings_delete_confirm_submit()}')
			)
		);
		expect(deleteSubmitBlock.slice(0, deleteSubmitBlock.indexOf('>'))).toContain(
			'variant="danger"'
		);
	});

	it('does not use solid danger for any button that only opens a ConfirmDialog', () => {
		expect.assertions(1);

		// Every `<ConfirmDialog ... open={...}>` in this file is preceded by trigger button(s)
		// setting that same boolean to true; none of those triggers should render solid `danger`.
		const openFlagNames = [...settingsPage.matchAll(/<ConfirmDialog\s+open=\{(\w+)\}/g)].map(
			(match) => match[1]
		);
		expect(openFlagNames).toEqual(['restoreConfirmOpen']);
	});
});
