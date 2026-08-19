import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import { setPendingDesignation } from '$lib/import/pendingDesignation.svelte';
import { clearPendingCollision } from '$lib/import/pendingCollision.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';

/**
 * THE SEAM Planche 5c moved, asserted where it now lives: the route decides what is POSTED, and it
 * must follow the answer the screen just gave rather than anything carried across a navigation.
 *
 * ## What this replaces
 *
 * `correction-consent.svelte.spec.ts` used to guard this on `/import`, where the control lived. The
 * defect it was written against was measured in a browser: the consent was posted with a first
 * press, echoed back by the server, and the handoff read the echo, so a user who unticked after
 * that first press lost the import they had chosen to keep. The control and the submit are now on
 * one screen, which makes that particular echo unrepresentable, but the property it protected is
 * unchanged and still needs a test: WHAT IS POSTED follows the control.
 *
 * ## The two halves come from different places, on purpose
 *
 * The consent is the screen's answer. The batch id is what the SERVER resolved, against this user
 * and against the correspondance being corrected, and it is the only version allowed to name a
 * delete (ASVS 5.0 v5.0.0-2.2.1, v5.0.0-8.2.2). A repair that rebuilt both from one place would fix
 * nothing and lose that property silently, so the fixture gives the resolved id a value no other
 * field carries.
 *
 * ## Asserted on the request body, not on a mock's arguments
 *
 * `fetch` is stubbed because the route posts through it, and what is read back is the `FormData`
 * the route actually assembled. Asserting that a handler was called with a boolean would assert the
 * test's own plumbing; asserting the body asserts what the server will receive.
 */
const RESOLVED_BATCH = 'batch-resolved-by-the-server';

const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['MERCERIE'], ['-24,90']],
	previewRows: [['24/06/2026', 'MERCERIE', '-24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'MERCERIE', '-24,90'],
	rowCount: 25,
	hasHeaderRow: true
} as DesignationFile;

const COMPLETE = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

let posted: FormData | null = null;

function seed() {
	setPendingDesignation({
		file: new File(['Jour;Intitule;Somme\n'], 'releve.csv'),
		view: VIEW,
		initialAssignment: COMPLETE,
		candidates: {},
		correction: {
			mappingId: 'mapping-1',
			batchId: RESOLVED_BATCH,
			namedAt: '1 juillet 2026 à 10:59',
			replacedRows: 25,
			hasUserWork: false
		}
	});
}

beforeEach(() => {
	posted = null;
	clearPendingCollision();
	vi.clearAllMocks();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			posted = init.body as FormData;
			// A body the route will treat as an unexpected shape, so it stops rather than navigating.
			// What is under test is what it SENT, and nothing after the send.
			return new Response('{"type":"success","status":200}', { status: 200 });
		})
	);
});

async function pressPrimary() {
	await page.viewport(390, 844);
	seed();
	render(Page, { form: null as never });
	const primary = document.querySelector('[data-testid="designation-primary"]') as HTMLElement;
	primary.click();
	await new Promise((r) => setTimeout(r, 0));
	return primary;
}

describe('what the correction posts, and what decides it', () => {
	// Ticked is the default, so the press opens the confirmation and posts NOTHING yet. This is the
	// half that separates « the box arms the delete » from « the box proposes and the modal
	// consents »: a run that posted here would delete on a single press.
	it('posts nothing on the press while the confirmation is unanswered', async () => {
		await pressPrimary();

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(posted).toBeNull();
	});

	it('posts the server-resolved batch id once the confirmation is answered', async () => {
		await pressPrimary();
		const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
			b.textContent?.includes('Importer et supprimer')
		) as HTMLElement;
		confirm.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(posted).not.toBeNull();
		expect(posted!.get('replaceBatchId')).toBe(RESOLVED_BATCH);
	});

	// THE DIRECTION THE OLD GUARD PROTECTED. Untick, press, and no batch id travels at all. Absent
	// rather than `'false'`: an unchecked box must reach the server as « the field was never added »
	// and not as a value the action has to interpret.
	it('posts no batch id at all when the consent is untied', async () => {
		await page.viewport(390, 844);
		seed();
		render(Page, { form: null as never });

		const box = document.querySelector(
			'[data-testid="designation-replace-consent"] input[type="checkbox"]'
		) as HTMLInputElement;
		box.click();
		await new Promise((r) => setTimeout(r, 0));

		(document.querySelector('[data-testid="designation-primary"]') as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(posted).not.toBeNull();
		expect(posted!.get('replaceBatchId')).toBeNull();
	});
});

/**
 * THE COLLISION BRANCH IS ASSERTED ELSEWHERE, and where it went is the finding.
 *
 * A run that collides hands the dialog a repost, and that mapping carried
 * `pending.view.hasHeaderRow` — DETECTION'S GUESS — where it should have carried the user's answer.
 * `/import`'s action always sends the first as `true`, so answering « Importer quand même » re-posted
 * a header row against a file the user had declared headerless and the server ate its first line.
 *
 * A test was written here first and could not reach the branch: it is entered only through a
 * serialised `ActionResult`, and a hand-built payload does not survive `deserialize`, so the route
 * landed in its own catch and the assertion read `undefined` for a reason that had nothing to do
 * with its claim. The TRANSPORT was what made the seam untestable, not the mapping.
 *
 * So the mapping moved out into `$lib/import/collisionRepost.ts`, where it is a pure function with
 * a fixture whose two `hasHeaderRow` values DIFFER. Every collision fixture in this repository kept
 * them equal, which is why a mapping reading the wrong one agreed with the right one.
 */
