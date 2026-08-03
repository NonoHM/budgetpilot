import { page, userEvent } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import type { ActionData, PageData } from './$types';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';

/**
 * Task 6.2 steps 3-4: the bulk-tag confirmation dialog and the undo banner.
 *
 * The trigger, the dialog and the banner all read `data.filters`/`form` directly, so a plain
 * render with a crafted fixture exercises the real component instead of a mock of it.
 */

function baseData(overrides: Record<string, unknown> = {}): PageData {
	return {
		user: { email: 'test@example.com', role: 'USER' as const },
		transactions: [],
		selectedTransaction: null,
		selectedSuggestion: null,
		categoryOptions: ['Loyer'],
		categories: [{ name: 'Loyer', defaultKey: null }],
		allTags: [{ id: 'tag-1', name: 'Voyage', colorToken: 'clay' as const }],
		natureOptions: TRANSACTION_NATURES,
		filters: {
			q: '',
			qMode: 'contains' as const,
			type: 'all',
			category: '',
			from: '',
			to: '',
			importBatchId: '',
			ids: '',
			tag: ''
		},
		filteredTotals: { incomeCents: 0, expenseCents: 0 },
		queryError: false,
		dateRangeError: false,
		pagination: {
			page: 1,
			pageSize: 25,
			totalTransactions: 12,
			totalPages: 1,
			hasPrevious: false,
			hasNext: false
		},
		uncategorizedCount: 0,
		classifiableCount: 0,
		classifyStackIds: [],
		...overrides
	} as unknown as PageData;
}

/** Matched on the label's stable stem rather than a full string, because the label now carries the
 *  filtered count and therefore differs per fixture — see the label tests below, which assert the
 *  exact wording. */
function bulkTagButtons(): HTMLButtonElement[] {
	return [...document.querySelectorAll('button')].filter((button) =>
		/^Étiqueter le/.test(button.textContent?.trim() ?? '')
	) as HTMLButtonElement[];
}

describe('bulk-tag trigger', () => {
	it('desktop: is aria-disabled, not disabled, when no filter is active', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const [trigger] = bulkTagButtons();
		expect(trigger).toBeDefined();
		expect(trigger.getAttribute('aria-disabled')).toBe('true');
		// A native `disabled` attribute would drop the element from the tab order; aria-disabled
		// must not.
		expect(trigger.disabled).toBe(false);
	});

	it('desktop: is enabled once a filter (category) is active', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Loyer' } }),
			form: null
		});

		const [trigger] = bulkTagButtons();
		expect(trigger.getAttribute('aria-disabled')).toBeNull();
	});

	it('mobile: is aria-disabled, not disabled, when no filter is active', async () => {
		await page.viewport(390, 844);
		render(Page, { data: baseData(), form: null });

		const [trigger] = bulkTagButtons();
		expect(trigger).toBeDefined();
		expect(trigger.getAttribute('aria-disabled')).toBe('true');
		expect(trigger.disabled).toBe(false);
	});

	it('mobile: is enabled once a filter (category) is active', async () => {
		await page.viewport(390, 844);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Loyer' } }),
			form: null
		});

		const [trigger] = bulkTagButtons();
		expect(trigger.getAttribute('aria-disabled')).toBeNull();
	});

	it('desktop: explains why via one visible sentence wired through aria-describedby, never a title or a duplicate aria-label', async () => {
		// BREAK-THE-CHECK: reverting to the earlier `aria-label` (no visible sentence,
		// aria-describedby unset) makes the `getElementById` lookup null and this fails — verified
		// by hand, see the PR report.
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const [trigger] = bulkTagButtons();
		expect(trigger.getAttribute('title')).toBeNull();
		expect(trigger.getAttribute('aria-label')).toBeNull();

		const describedById = trigger.getAttribute('aria-describedby');
		expect(describedById).toBeTruthy();
		const reason = describedById ? document.getElementById(describedById) : null;
		expect(reason).toBeTruthy();
		expect(reason?.textContent?.trim().length).toBeGreaterThan(0);
	});

	it('desktop: has no aria-describedby, and no visible reason, once enabled', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Loyer' } }),
			form: null
		});

		const [trigger] = bulkTagButtons();
		expect(trigger.getAttribute('aria-describedby')).toBeNull();
		expect(document.getElementById('bulk-tag-disabled-reason-desktop')).toBeNull();
	});

	it.each([
		[1280, 800, 'desktop'],
		[390, 844, 'mobile']
	])(
		'%s x %s (%s): writes the filtered count in the label, so the scope is known before the dialog opens',
		async (width, height) => {
			// The design's own wording ("Étiqueter les 6 résultats" / "Étiqueter les résultats"), and
			// its stated reason: "on sait ce qu'on va toucher avant même d'ouvrir la modale". It
			// shipped as "Appliquer une étiquette" in both states, so the count only ever appeared one
			// click later.
			//
			// Both breakpoints, because the trigger is duplicated per breakpoint and a label fixed on
			// one surface only is this repo's most-repeated defect shape.
			await page.viewport(width, height);

			const filtered = render(Page, {
				data: baseData({
					filters: { ...baseData().filters, category: 'Loyer' },
					pagination: { ...baseData().pagination, totalTransactions: 6 }
				}),
				form: null
			});
			expect(bulkTagButtons()[0].textContent?.trim()).toBe('Étiqueter les 6 résultats');
			filtered.unmount();

			// No filter: no set to count, so the label states the action without inventing a number.
			render(Page, { data: baseData(), form: null });
			expect(bulkTagButtons()[0].textContent?.trim()).toBe('Étiqueter les résultats');
		}
	);

	it('says "le résultat", not "les 1 résultats", when the filter matches a single row', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				filters: { ...baseData().filters, category: 'Loyer' },
				pagination: { ...baseData().pagination, totalTransactions: 1 }
			}),
			form: null
		});

		expect(bulkTagButtons()[0].textContent?.trim()).toBe('Étiqueter le résultat');
	});

	it('counts the whole filtered set, not the current page', async () => {
		// BREAK-THE-CHECK: sourcing the count from `data.transactions.length` (the page) instead of
		// `pagination.totalTransactions` (the set) makes this read "Étiqueter les 2 résultats" —
		// verified by hand, see the PR report. That number would also contradict the dialog, which
		// quotes the set.
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				filters: { ...baseData().filters, category: 'Loyer' },
				transactions: [],
				pagination: { ...baseData().pagination, totalTransactions: 301, pageSize: 25 }
			}),
			form: null
		});

		expect(bulkTagButtons()[0].textContent?.trim()).toBe('Étiqueter les 301 résultats');
	});

	it('desktop: keeps the inactive label at zinc-500 (measured 4.6:1), not dimmed further by opacity', async () => {
		// Two separate assertions on purpose: `color` alone does not catch a stray `opacity` class
		// — `opacity` composites toward the background at paint time, it never changes the `color`
		// value `getComputedStyle` reports, so a colour-only check is one of the "structurally
		// incapable of failing" assertions CLAUDE.md warns about for exactly this shape.
		//
		// BREAK-THE-CHECK: adding an `opacity-40` class alongside `text-zinc-500` on the inactive
		// button leaves the `color` assertion green and turns the `opacity` assertion red —
		// verified by hand, see the PR report for the exact value observed (0.4).
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: null });

		const [trigger] = bulkTagButtons();
		// Tailwind v4 defines its palette in oklch; this is Tailwind's own zinc-500 value, not a
		// recomputation.
		const ZINC_500 = 'oklch(0.552 0.016 285.938)';
		expect(getComputedStyle(trigger).color).toBe(ZINC_500);
		expect(getComputedStyle(trigger).opacity).toBe('1');
	});
});

describe('bulk-tag confirm dialog', () => {
	it('names the count and every active filter fragment, not just the count', async () => {
		// BREAK-THE-CHECK: strip describeBulkTagFilter's body down to `return [];` in
		// +page.svelte and this assertion fails (dialog text stops containing the fragments)
		// while the count assertion alone would still pass — which is exactly the gap the
		// "not just the count" constraint exists to close.
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({
				filters: {
					...baseData().filters,
					category: 'Loyer',
					q: 'edf',
					tag: 'tag-1',
					from: '2026-01-01',
					to: '2026-01-31'
				}
			}),
			form: null
		});

		const [trigger] = bulkTagButtons();
		await userEvent.click(trigger);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).toBeTruthy();
		const text = dialog?.textContent ?? '';
		expect(text).toContain('12'); // count
		expect(text).toContain('Loyer'); // category
		expect(text).toContain('edf'); // search term
		expect(text).toContain('Voyage'); // tag
		expect(text).toContain('janvier'); // period, from formatDate
	});

	it('closes without submitting via the cancel control', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData({ filters: { ...baseData().filters, category: 'Loyer' } }),
			form: null
		});

		const [trigger] = bulkTagButtons();
		await userEvent.click(trigger);
		expect(document.querySelector('[role="dialog"]')).toBeTruthy();

		await userEvent.click(page.getByText('Annuler').first());
		await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
	});
});

describe('bulk-tag undo banner', () => {
	const bulkTagResult = {
		tagId: 'tag-1',
		tagName: 'Voyage',
		appliedCount: 7,
		transactionIds: ['tx-1', 'tx-2', 'tx-3']
	};

	it('renders the undo form OUTSIDE the AlertBanner, with the button wired via form=', async () => {
		await page.viewport(1280, 800);
		render(Page, {
			data: baseData(),
			form: { bulkTagResult } as unknown as ActionData
		});

		const banner = document.querySelector('[role="status"]');
		expect(banner).toBeTruthy();
		const undoForm = document.getElementById('bulk-tag-undo-banner');
		expect(undoForm).toBeTruthy();
		// Structural: the form must NOT be a descendant of the banner's own <p> — AlertBanner
		// renders a <p>, and a <form> start tag would close it in the HTML parser if nested.
		expect(banner?.contains(undoForm)).toBe(false);

		const undoButton = [...document.querySelectorAll('button')].find(
			(button) => button.getAttribute('form') === 'bulk-tag-undo-banner'
		);
		expect(undoButton).toBeTruthy();
		expect(banner?.contains(undoButton ?? null)).toBe(true);

		const tagIdInput = undoForm?.querySelector('input[name="tagId"]') as HTMLInputElement;
		const idsInput = undoForm?.querySelector('input[name="transactionIds"]') as HTMLInputElement;
		expect(tagIdInput.value).toBe('tag-1');
		expect(idsInput.value).toBe('tx-1,tx-2,tx-3');
	});

	it.each([
		[1280, 800, 'desktop'],
		[390, 844, 'mobile']
	])(
		'%s x %s (%s): puts "Annuler" immediately after the trigger in tab order, which is what makes not moving focus acceptable',
		async (width, height) => {
			// The design declines to move focus after a bulk apply, and its justification is a DOM
			// fact, not a preference: "Le bandeau étant inséré juste sous la barre de filtres,
			// « Annuler » est le tout premier arrêt de tabulation après le déclencheur… C'est ce
			// placement dans le DOM qui rend le non-déplacement acceptable — s'il était rendu ailleurs
			// dans la page, la décision inverse s'imposerait."
			//
			// It was rendered above the filter bar, so Annuler came 16 focusable stops BEFORE the
			// trigger (measured on a live page after tagging 100 rows), on the only path back from a
			// mis-scoped bulk apply. Focus stayed on the trigger, as designed, and the premise that
			// made that safe was false.
			//
			// Asserted over the real focus order rather than "the banner is below the bar" in the
			// markup, because the tab stop is the thing the reasoning depends on.
			//
			// BREAK-THE-CHECK: moving the banner block back above the desktop filter bar makes this
			// fail with the trigger at a HIGHER index than the undo — verified by hand, see the PR
			// report.
			await page.viewport(width, height);
			const { container } = render(Page, {
				data: baseData({ filters: { ...baseData().filters, category: 'Loyer' } }),
				form: { bulkTagResult } as unknown as ActionData
			});

			const focusables = [...container.querySelectorAll<HTMLElement>('button, a[href], input')]
				// Only the surface this viewport actually shows: the other breakpoint's copy is
				// display:none and takes no tab stop, so counting it would measure nothing real.
				.filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled);

			const trigger = focusables.find((el) => /^Étiqueter le/.test(el.textContent ?? ''));
			const undo = focusables.find((el) => el.getAttribute('form') === 'bulk-tag-undo-banner');
			expect(trigger).toBeTruthy();
			expect(undo).toBeTruthy();

			expect(focusables.indexOf(undo!)).toBe(focusables.indexOf(trigger!) + 1);
		}
	);

	it('names the applied count and the tag', async () => {
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: { bulkTagResult } as unknown as ActionData });

		await expect
			.element(page.getByText('Étiquette « Voyage » appliquée à 7 transactions.'))
			.toBeInTheDocument();
	});

	it('does NOT auto-dismiss, unlike the other success banners on this page', async () => {
		// Real timers, not fake ones: AlertBanner's dismissal is a setTimeout flipping `dismissed`
		// followed by an svelte/transition `out:fly`, and advancing a FAKE timer past the delay
		// flips the flag without ever running the real animation frames the transition needs to
		// complete, so the element stays attached and the assertion below would pass either way. A
		// real, short wait is what AlertBanner.svelte.spec.ts's own "auto-hides" test already uses.
		//
		// BREAK-THE-CHECK: passing a finite `autoDismissMs` on the "applied" banner (this page,
		// tags_bulk banner just below the description comment) instead of `Infinity` makes this
		// fail once real time crosses that value — verified by hand at 40ms, see the PR report.
		await page.viewport(1280, 800);
		render(Page, { data: baseData(), form: { bulkTagResult } as unknown as ActionData });

		await expect
			.element(page.getByText('Étiquette « Voyage » appliquée à 7 transactions.'))
			.toBeInTheDocument();

		await new Promise((resolve) => setTimeout(resolve, 300));

		await expect
			.element(page.getByText('Étiquette « Voyage » appliquée à 7 transactions.'))
			.toBeInTheDocument();
	});

	it('keys the banner on the result object, so a second identical action can be announced again', async () => {
		await page.viewport(1280, 800);
		const screen = render(Page, {
			data: baseData(),
			form: { bulkTagResult } as unknown as ActionData
		});

		await expect
			.element(page.getByText('Étiquette « Voyage » appliquée à 7 transactions.'))
			.toBeInTheDocument();

		// A fresh result object with the SAME content, as SvelteKit hands back per submission.
		await screen.rerender({
			data: baseData(),
			form: { bulkTagResult: { ...bulkTagResult } } as unknown as ActionData
		});

		await expect
			.element(page.getByText('Étiquette « Voyage » appliquée à 7 transactions.'))
			.toBeInTheDocument();
	});
});
