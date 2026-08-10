import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SplitRemainderBand from './SplitRemainderBand.svelte';
import { resolveRemainder } from '$lib/domain/splitDraft';
import { ANNOUNCE_PAUSE_MS } from '$lib/announce';

/**
 * THE PAIRING, not its two halves.
 *
 * `announce.spec.ts` proves the timing policy in isolation and `splitDraft.spec.ts` proves the
 * arithmetic in isolation. Both were green while this component did not exist, which is exactly the
 * per-leg blindness the first standing principle is about: each part correct, the combination
 * unasserted. The wiring is where they meet — which state feeds which sentence, which element is
 * `aria-hidden`, and which one `aria-describedby` may point at — and none of that is visible from
 * either half.
 */

const EXPENSE_TOTAL = -8_000;
const ANNOUNCEMENT_ID = 'split-remainder-announcement';

function liveRegion(): HTMLElement {
	const el = document.getElementById(ANNOUNCEMENT_ID);
	if (!el) throw new Error('the live region is missing entirely');
	return el;
}

function band(): HTMLElement {
	const el = document.querySelector('[aria-hidden="true"]');
	if (!el) throw new Error('no aria-hidden band rendered');
	return el as HTMLElement;
}

describe('SplitRemainderBand — the visible half', () => {
	it.each([
		[['0,00', '0,00'], 'Reste à répartir', '80,00'],
		[['60,00', '20,00'], 'Tout est réparti', '0,00'],
		[['60,00', '25,00'], 'Dépassement', '5,00']
	])('%s renders « %s »', async (amounts, label, amount) => {
		render(SplitRemainderBand, {
			remainder: resolveRemainder(amounts as string[], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		const text = band().textContent ?? '';
		expect(text).toContain(label);
		expect(text.replace(/[\u202f\u00a0]/g, ' ')).toContain(amount);
	});

	it('quotes the MAGNITUDE, never a signed value', async () => {
		// 1d: « Une formulation unique du type "Reste : −5,00 €" obligerait à lire un signe pour
		// comprendre un sens, et un signe moins de 8 px de large ne porte pas une information à lui
		// seul. » The three states are told apart by their words, not by a glyph.
		render(SplitRemainderBand, {
			remainder: resolveRemainder(['60,00', '25,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		expect(band().textContent).not.toContain('-5');
		expect(band().textContent).not.toContain('−5');
	});

	it('is aria-hidden, and the live region is NOT inside it', async () => {
		// The rule 1p says must not be re-broken. An `aria-hidden` element takes its descendants out
		// of the accessibility tree, so a region nested inside the band would expose nothing — and
		// would look completely correct in the rendered page.
		render(SplitRemainderBand, {
			remainder: resolveRemainder(['60,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		expect(band().getAttribute('aria-hidden')).toBe('true');
		expect(band().contains(liveRegion())).toBe(false);
		expect(liveRegion().closest('[aria-hidden="true"]')).toBeNull();
	});

	it('is a status region, not an alert — an overshoot is a form state, not an incident', async () => {
		render(SplitRemainderBand, {
			remainder: resolveRemainder(['60,00', '25,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		expect(liveRegion().getAttribute('role')).toBe('status');
		expect(liveRegion().getAttribute('aria-live')).toBe('polite');
	});
});

describe('SplitRemainderBand — the pairing', () => {
	// `advanceTimersByTimeAsync`, never the sync form: committing a sentence sets a `$state`, and
	// Svelte flushes that to the DOM on the next microtask. The sync advance fires the timer and
	// returns before the region has been rewritten, so every assertion here would read the previous
	// sentence and the suite would report the announcer as broken when it is the test that is early.
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('opens holding its sentence, so mounting the panel says nothing new', async () => {
		render(SplitRemainderBand, {
			remainder: resolveRemainder(['0,00', '0,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		// Present at first render — a status region created WITH content does not speak.
		expect(liveRegion().textContent).toContain('Reste à répartir');
		expect(liveRegion().textContent).toContain('80,00');
		// Spelled, not the € glyph.
		expect(liveRegion().textContent).toContain('euros');
		expect(liveRegion().textContent).not.toContain('€');
	});

	it('does NOT rewrite the region on every state change — only after the pause', async () => {
		// Four states inside one pause is the typing case. The band's own text tracks every one of
		// them; the region must not.
		const { rerender } = render(SplitRemainderBand, {
			remainder: resolveRemainder(['0,00', '0,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		for (const amounts of [['6'], ['60'], ['60,0'], ['60,00']]) {
			await rerender({
				remainder: resolveRemainder(amounts, EXPENSE_TOTAL),
				announcementId: ANNOUNCEMENT_ID
			});
			await vi.advanceTimersByTimeAsync(120);
		}

		// The visible band HAS followed every keystroke — that is its job.
		expect(band().textContent?.replace(/[\u202f\u00a0]/g, ' ')).toContain('20,00');
		// The region has not moved off the sentence it opened with.
		expect(liveRegion().textContent).toContain('80,00');

		await vi.advanceTimersByTimeAsync(ANNOUNCE_PAUSE_MS);
		expect(liveRegion().textContent).toContain('20,00');
	});

	it('speaks the state that matches the band, not one keystroke behind it', async () => {
		// The pairing failure that a per-half test cannot see: a correct policy fed a stale state, or
		// a correct state fed to the wrong sentence builder. Both halves pass; the panel lies.
		const { rerender } = render(SplitRemainderBand, {
			remainder: resolveRemainder(['0,00', '0,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		await rerender({
			remainder: resolveRemainder(['60,00', '25,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		await vi.advanceTimersByTimeAsync(ANNOUNCE_PAUSE_MS);

		expect(band().textContent).toContain('Dépassement');
		expect(liveRegion().textContent).toContain('Dépassement');
		expect(liveRegion().textContent).toContain('5,00');
		expect(liveRegion().textContent).toContain('indisponible');
	});

	it('announces that Save is available exactly when the remainder reaches zero', async () => {
		const { rerender } = render(SplitRemainderBand, {
			remainder: resolveRemainder(['60,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});

		await rerender({
			remainder: resolveRemainder(['60,00', '20,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		await vi.advanceTimersByTimeAsync(ANNOUNCE_PAUSE_MS);

		expect(liveRegion().textContent).toBe('Tout est réparti. Enregistrer est disponible.');
	});

	it('stays silent when a keystroke and its deletion land back on the same state', async () => {
		const { rerender } = render(SplitRemainderBand, {
			remainder: resolveRemainder(['60,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		await vi.advanceTimersByTimeAsync(ANNOUNCE_PAUSE_MS);
		const settled = liveRegion().textContent;

		await rerender({
			remainder: resolveRemainder(['60,0'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		await vi.advanceTimersByTimeAsync(100);
		await rerender({
			remainder: resolveRemainder(['60,00'], EXPENSE_TOTAL),
			announcementId: ANNOUNCEMENT_ID
		});
		await vi.advanceTimersByTimeAsync(ANNOUNCE_PAUSE_MS);

		expect(liveRegion().textContent).toBe(settled);
	});
});
