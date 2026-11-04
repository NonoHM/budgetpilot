import { page, userEvent } from 'vitest/browser';
import { describe, it, expect, vi } from 'vitest';

// Focus mode navigates with `goto` on open; the journey below only needs the overlay mounted.
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: vi.fn(async () => {})
}));
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { PageData } from './$types';
import { TRANSACTION_NATURES, type TransactionNature } from '$lib/domain/transaction';
import * as m from '$lib/paraglide/messages';
import { MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';

const SPENDING: TransactionNature = 'spending';

/**
 * The detail panel's forms POST to a URL, and that URL is the WHOLE query string.
 *
 * A bare `action="?/saveManualCategory"` resolves to `/transactions?/saveManualCategory`, so a
 * native submit lands on a page with no `selected`, no filters and no page number: the panel the
 * form lives in is gone, and with it the only place its refusal is rendered. `saveSplits` already
 * carries the selection for exactly this reason (+page.svelte's `splitFormAction` docstring); this
 * asserts its three siblings in the same panel do too.
 *
 * The action is parsed the way SvelteKit parses it (the param whose key starts with `/` names the
 * action, every other param rides along) rather than compared against a rebuilt string, so this
 * test shares no source with the builder it is checking.
 */
function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [
			{
				id: 'tx-1',
				date: '2026-06-12',
				label: 'Carrefour Market',
				category: 'Alimentation',
				importedCategory: 'Alimentation',
				manualCategory: 'Alimentation',
				isManualCategory: true,
				nature: SPENDING,
				natureSource: 'manual' as const,
				manualNature: SPENDING,
				amountCents: -5420,
				type: 'expense' as const,
				source: 'Carrefour Market SA',
				tags: [],
				splitIndicator: null,
				linkedAccount: null,
				matchedCategoryAllocation: null,
				suggestion: null
			}
		],
		selectedTransaction: {
			splits: [],
			splitInheritCategoryId: null,
			splitEntryAvailable: false,
			id: 'tx-1',
			date: '2026-06-12',
			label: 'Carrefour Market',
			amountCents: -5420,
			type: 'expense' as const,
			category: 'Alimentation',
			importedCategory: 'Alimentation',
			manualCategory: 'Alimentation',
			isManualCategory: true,
			nature: SPENDING,
			natureSource: 'manual' as const,
			manualNature: SPENDING,
			source: 'Carrefour Market SA',
			notes: null,
			reference: null,
			dedupeKey: null,
			createdAt: '2026-06-12T10:00:00.000Z',
			updatedAt: '2026-06-12T10:00:00.000Z',
			account: null,
			importBatch: null,
			bankFields: [],
			bankOperationType: null,
			subcategory: '',
			tags: []
		},
		allTags: [],
		selectedSuggestion: null,
		categoryOptions: ['Alimentation', 'Abonnements', 'Loisirs'],
		splitCategoryOptions: [],
		categories: [
			{ id: 'cat-alimentation', name: 'Alimentation' },
			{ id: 'cat-abonnements', name: 'Abonnements' },
			{ id: 'cat-loisirs', name: 'Loisirs' }
		],
		natureOptions: TRANSACTION_NATURES,
		splitFilterAvailable: false,
		splitCounts: null,
		// Every dimension the panel must not silently drop, set to a value a user could have chosen.
		filters: {
			q: 'carrefour',
			qMode: 'contains' as const,
			type: 'expense',
			category: 'Alimentation',
			from: '2026-06-01',
			to: '2026-06-30',
			importBatchId: '',
			ids: '',
			tag: 'Voyage',
			split: 'all'
		},
		filteredTotals: { incomeCents: 0, expenseCents: 5420 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 3,
			pageSize: 25,
			totalTransactions: 1,
			totalPages: 4,
			hasPrevious: true,
			hasNext: true
		},
		uncategorizedCount: 0,
		classifyStackIds: [],
		transferProposals: { pairs: [], ambiguousCount: 0 },
		transferPartner: null,
		tagCounts: null,
		tagScopeTotal: 0,
		bulkFallback: null,
		todayIso: '2026-06-17',
		...overrides
	};
}

/**
 * The two surfaces that render the detail, both mounted at every width with one hidden by CSS.
 *
 * The sheet is found by its `aria-modal` rather than by `[role="dialog"]` alone: the page also
 * renders `Modal` and `ConfirmDialog`, so the looser selector is right only for as long as no
 * fixture opens one, which is a coincidence rather than a property.
 */
function panelSurfaces(container: HTMLElement): Array<readonly [string, Element]> {
	const aside = container.querySelector('aside');
	const sheet = container.querySelector('[role="dialog"][aria-modal="true"]');
	expect(aside, 'desktop panel').not.toBeNull();
	expect(sheet, 'mobile sheet').not.toBeNull();
	return [
		['desktop panel', aside as Element],
		['mobile sheet', sheet as Element]
	] as const;
}

/** The action's query string, parsed as SvelteKit's own action resolution parses it. */
function actionParams(form: Element): URLSearchParams {
	const action = form.getAttribute('action') ?? '';
	return new URLSearchParams(action.slice(action.indexOf('?') + 1));
}

function expectCarriesSelectionAndFilters(form: Element, actionName: string): void {
	const params = actionParams(form);
	// The action itself: SvelteKit reads the param whose key starts with '/'.
	expect(params.has(`/${actionName}`)).toBe(true);
	expect(params.get('selected')).toBe('tx-1');
	expect(params.get('page')).toBe('3');
	expect(params.get('q')).toBe('carrefour');
	expect(params.get('category')).toBe('Alimentation');
	expect(params.get('from')).toBe('2026-06-01');
	expect(params.get('to')).toBe('2026-06-30');
	expect(params.get('tag')).toBe('Voyage');
	expect(params.get('type')).toBe('expense');
}

describe('the detail panel posts without discarding the panel', () => {
	it('manual category: both mounts carry the selection and every active filter', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, { data: baseData(), form: null });

		// Absolute figure beside the sweep: desktop panel and mobile sheet are both mounted at every
		// width and only one is shown by CSS, so a fix landing on one of them must not read as green.
		const forms = container.querySelectorAll('form[action$="/saveManualCategory"]');
		expect(forms.length).toBe(2);

		for (const form of forms) expectCarriesSelectionAndFilters(form, 'saveManualCategory');
	});

	it('manual category: a refusal is announced, in the form it belongs to', async () => {
		await page.viewport(1280, 900);
		// The refusal a user reaches by ordinary means: the parent's category is frozen while the
		// transaction is répartie, and the server refuses the write (+page.server.ts's
		// `splits: { none: {} }` guard). Before the panel survived the submit this sentence was
		// computed, returned, and rendered nowhere.
		const { container } = await render(Page, {
			data: baseData(),
			form: { manualCategoryError: m.transactions_error_category_locked_by_split() }
		});

		const forms = container.querySelectorAll('form[action$="/saveManualCategory"]');
		expect(forms.length).toBe(2);

		for (const form of forms) {
			// Announced rather than merely coloured: it arrives with nothing else on screen changing,
			// so a reader who is not looking at this corner of the panel has no other signal. Colour
			// alone would also be the only carrier of "this is a refusal".
			const alert = form.querySelector('[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain(m.transactions_error_category_locked_by_split());
		}
	});

	it('manual nature: both mounts carry the selection and every active filter', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, { data: baseData(), form: null });

		const forms = container.querySelectorAll('form[action$="/saveManualNature"]');
		expect(forms.length).toBe(2);

		for (const form of forms) expectCarriesSelectionAndFilters(form, 'saveManualNature');
	});

	it('manual nature: a refusal is announced, in the form it belongs to', async () => {
		await page.viewport(1280, 900);
		// The refusal this form can actually produce: the Select offers only valid natures, so the
		// reachable answer is the row having gone (deleted in another tab) between the selection and
		// the submit.
		const { container } = await render(Page, {
			data: baseData(),
			form: { manualNatureError: m.transactions_error_transaction_not_found() }
		});

		const forms = container.querySelectorAll('form[action$="/saveManualNature"]');
		expect(forms.length).toBe(2);

		for (const form of forms) {
			const alert = form.querySelector('[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain(m.transactions_error_transaction_not_found());
		}
	});

	it('étiquettes: both mounts carry the selection and every active filter', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, { data: baseData(), form: null });

		const forms = container.querySelectorAll('form[action$="/saveTags"]');
		expect(forms.length).toBe(2);

		for (const form of forms) expectCarriesSelectionAndFilters(form, 'saveTags');
	});

	it('étiquettes: a refusal is announced, in the form it belongs to', async () => {
		await page.viewport(1280, 900);
		// The cap sentence, asserted at this level ON PURPOSE and not in the e2e journey: TagPicker
		// refuses the eleventh selection itself (`atMax`), so no browser path reaches this refusal
		// and a journey claiming to exercise it would be claiming something false. What is asserted
		// here is narrower and true: when the server does answer with it, the panel renders it.
		const { container } = await render(Page, {
			data: baseData(),
			form: { tagsError: m.tags_error_too_many({ max: MAX_TAGS_PER_TRANSACTION }) }
		});

		const forms = container.querySelectorAll('form[action$="/saveTags"]');
		expect(forms.length).toBe(2);

		for (const form of forms) {
			const alert = form.querySelector('[role="alert"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent).toContain(
				m.tags_error_too_many({ max: MAX_TAGS_PER_TRANSACTION })
			);
		}
	});

	/**
	 * The enumeration made executable, and the reason this file is not four assertions about four
	 * known sites.
	 *
	 * #200 exists because a defect reported at one form was present at five, so a test naming the
	 * five would repeat the mistake it is fixing. This one asks the panel what forms it has and
	 * holds every one of them to the rule, so a NEW form added with a bare `action="?/..."` goes red
	 * without anyone remembering to extend a list. The absolute count is beside it because "every
	 * form carries the selection" is satisfied by a panel with no forms at all.
	 */
	it('every POST form in the panel carries the selection, at both mounts', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, { data: baseData(), form: null });

		for (const [surface, root] of panelSurfaces(container)) {
			const forms = [...root.querySelectorAll('form[method="POST"]')];
			// Manual category, manual nature, étiquettes. The répartition editor is the fourth and is
			// absent here because this fixture owns no parts; it is covered by its own specs and by
			// this count going red if it ever renders unconditionally.
			expect(forms.length, surface).toBe(3);

			for (const form of forms) {
				const where = `${surface}: ${form.getAttribute('action')}`;
				expect(actionParams(form).get('selected'), where).toBe('tx-1');
			}
		}
	});

	/**
	 * The classify tab, and the reason the case above is not the whole sweep.
	 *
	 * `/transactions?type=classify` mounts `TransactionProposalCard` INSIDE this panel, which brings a
	 * fifth form the default fixture never renders. A test whose fixture cannot reach a state is
	 * silent about that state while reading as though it covered everything, which is the failure
	 * #200 was filed about, one level up.
	 *
	 * `?/acceptSuggestion` is asserted as it IS, bare, rather than fixed here, and the verdict is
	 * written down instead: it is `use:enhance`d, so it never navigates and loses nothing that a
	 * reader would see. It is the one form on this route where the no-javascript argument used for
	 * its three siblings applies and was not acted on, because its component is mounted outside this
	 * panel too and that is a fourth decision rather than this one. The day it changes, this case
	 * goes red and says so.
	 */
	it('the classify tab adds a fifth form, and its verdict is recorded rather than assumed', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, {
			data: baseData({
				filters: { ...baseData().filters, type: 'classify' },
				uncategorizedCount: 1,
				classifyStackIds: ['tx-1']
			}),
			form: null
		});

		for (const [surface, root] of panelSurfaces(container)) {
			const actions = [...root.querySelectorAll('form[method="POST"]')].map((form) =>
				form.getAttribute('action')
			);
			expect(actions.length, surface).toBe(4);

			const bare = actions.filter((action) => action?.startsWith('?/'));
			expect(bare, surface).toEqual(['?/acceptSuggestion']);

			for (const action of actions.filter((candidate) => !candidate?.startsWith('?/'))) {
				const params = new URLSearchParams((action ?? '').slice((action ?? '').indexOf('?') + 1));
				expect(params.get('selected'), `${surface}: ${action}`).toBe('tx-1');
			}
		}
	});
});

/**
 * #1014, the list half: a row's proposal says where it comes from, and both list accept forms
 * (the desktop row and the mobile card) post the proposal they showed as `proposed`, which is what
 * the server uses to refuse a proposal on a row filed since. The panel is left closed so every
 * form counted here is a list form.
 */
describe('the proposal on the list rows (#1014)', () => {
	it('names its source on both list layouts and posts the proposal from both forms', async () => {
		await page.viewport(1280, 900);
		const [row] = baseData().transactions;
		const { container } = await render(Page, {
			data: baseData({
				filters: { ...baseData().filters, type: 'classify' },
				transactions: [
					{
						...row,
						category: 'uncategorized',
						manualCategory: null,
						isManualCategory: false,
						suggestion: { category: 'Courses', nature: null, source: 'history' }
					}
				],
				selectedTransaction: null,
				uncategorizedCount: 1,
				classifyStackIds: ['tx-1']
			}),
			form: null
		});

		const labels = [...container.querySelectorAll('span')].filter(
			(el) => el.textContent?.trim() === m.transactions_proposal_from_history()
		);
		expect(labels).toHaveLength(2);

		// Three forms: the two list forms, and the hidden one focus mode's « Create a rule » submits
		// before the rule. It carries the field too (empty at rest, filled with the proposal the
		// focus card showed when the gesture fires), so an untouched proposal is recorded as
		// accepted and gets the same stale guard (code pass 1, A F1).
		const proposed = [...container.querySelectorAll('form[action="?/acceptSuggestion"]')].map(
			(form) => (form.querySelector('input[name="proposed"]') as HTMLInputElement | null)?.value
		);
		expect(proposed).toEqual(['Courses', 'Courses', '']);
	});
});

/**
 * #1014, code pass 1 (A F1) and the narrow pass on its fix: focus mode's « Create a rule » first
 * accepts the row through a hidden form, and that form must post the proposal the focus card
 * showed. Posting none stored an untouched proposal as the member's own choice, which the history
 * then learned, and dropped the stale guard. The field's value is only set when the gesture fires,
 * so this presses R in the open overlay and reads what the form submits.
 */
describe('focus mode « Create a rule » (#1014)', () => {
	it('posts the proposal the focus card showed', async () => {
		await page.viewport(1280, 900);
		const submitted: FormData[] = [];
		const spy = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (
			this: HTMLFormElement
		) {
			submitted.push(new FormData(this));
		});
		try {
			await render(Page, {
				data: baseData({
					filters: { ...baseData().filters, type: 'classify' },
					uncategorizedCount: 1,
					classifyStackIds: ['tx-1'],
					selectedSuggestion: { category: 'Loisirs', nature: null, source: 'history' }
				}),
				form: null
			});
			await page.getByRole('button', { name: m.transactions_focus_mode() }).first().click();
			await expect.element(page.getByRole('dialog')).toBeVisible();
			await userEvent.keyboard('r');
			await expect.poll(() => submitted.length).toBeGreaterThan(0);
			const accept = submitted.find((form) => form.has('proposed'));
			expect(accept?.get('proposed')).toBe('Loisirs');
			expect(accept?.get('category')).toBe('Loisirs');
		} finally {
			spy.mockRestore();
		}
	});
});

/**
 * #1230: « Accept all » names the proposals the page shows and posts them back as shown, and the
 * undo banner says what the server counted. Two list rows carry a proposal, a third carries none,
 * so a button counting rows rather than proposals reads 3 and fails here.
 */
describe('« Accept all » over the proposals the page shows (#1230)', () => {
	function classifyFixture() {
		const [row] = baseData().transactions;
		const pending = { ...row, category: 'uncategorized', manualCategory: null };
		return baseData({
			filters: { ...baseData().filters, type: 'classify' },
			transactions: [
				{
					...pending,
					id: 'tx-1',
					suggestion: { category: 'Courses', nature: null, source: 'history' }
				},
				{
					...pending,
					id: 'tx-2',
					suggestion: { category: 'Loisirs', nature: 'spending', source: 'rule' }
				},
				{ ...pending, id: 'tx-3', suggestion: null }
			],
			selectedTransaction: null,
			uncategorizedCount: 3,
			classifyStackIds: ['tx-1', 'tx-2', 'tx-3']
		});
	}

	it.each([
		[1280, 900],
		[390, 844]
	])('at %i px, counts the proposals and posts each as shown', async (width, height) => {
		await page.viewport(width, height);
		const { container } = await render(Page, { data: classifyFixture(), form: null });
		const forms = [
			...container.querySelectorAll<HTMLFormElement>('form[action="?/acceptAllProposals"]')
		].filter((form) => form.offsetParent !== null);
		expect(forms).toHaveLength(1);
		expect(forms[0].querySelector('button')?.textContent?.trim()).toBe(
			m.transactions_accept_all({ count: 2 })
		);
		const posted = (forms[0].querySelector('input[name="proposals"]') as HTMLInputElement).value;
		expect(JSON.parse(posted)).toEqual([
			{ id: 'tx-1', category: 'Courses', nature: null },
			{ id: 'tx-2', category: 'Loisirs', nature: 'spending' }
		]);
	});

	it('offers no « Accept all » when no row on the page carries a proposal', async () => {
		await page.viewport(1280, 900);
		const fixture = classifyFixture();
		const { container } = await render(Page, {
			data: {
				...fixture,
				transactions: fixture.transactions.map((tx) => ({ ...tx, suggestion: null }))
			},
			form: null
		});
		expect(container.querySelectorAll('form[action="?/acceptAllProposals"]')).toHaveLength(0);
	});

	function bannerText(container: HTMLElement): string {
		const banner = [...container.querySelectorAll('[role="status"], [role="alert"]')].find((el) =>
			el.querySelector('form[action="?/undoAcceptedProposals"]')
		);
		return banner ? (banner.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
	}

	it('says how many it categorized and how many it skipped, beside an undo of exactly them', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, {
			data: classifyFixture(),
			form: { proposalsAccepted: { accepted: 2, changedSince: 1, undo: 'RECORD' } } as never
		});
		expect(bannerText(container)).toContain(
			`${m.transactions_accepted_many({ count: 2 })} ${m.transactions_accepted_skipped_one()} ${m.transactions_accepted_undo()}`
		);
		const undo = container.querySelector(
			'form[action="?/undoAcceptedProposals"] input[name="undo"]'
		) as HTMLInputElement;
		expect(undo.value).toBe('RECORD');
	});

	// Code pass 1A U1: a second Undo would find every row restored and, answering last, say they
	// were kept. Separates an Undo held while its post is in flight from one that can be sent twice.
	it('holds Undo while its post is in flight', async () => {
		await page.viewport(1280, 900);
		const pending = vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => {}));
		try {
			const { container } = await render(Page, {
				data: classifyFixture(),
				form: { proposalsAccepted: { accepted: 2, changedSince: 0, undo: 'RECORD' } } as never
			});
			const button = container.querySelector(
				'form[action="?/undoAcceptedProposals"] button'
			) as HTMLButtonElement;
			expect(button.disabled).toBe(false);
			await userEvent.click(button);
			await expect.poll(() => button.disabled).toBe(true);
		} finally {
			pending.mockRestore();
		}
	});

	it('after an undo that found every row changed, says only that they were kept', async () => {
		await page.viewport(1280, 900);
		const { container } = await render(Page, {
			data: classifyFixture(),
			form: { proposalsUndone: { undone: 0, changedSince: 2 } } as never
		});
		const text = (container.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain(m.transactions_accepted_undone_kept_many({ count: 2 }));
		expect(text).not.toContain(m.transactions_accepted_undone());
	});
});
