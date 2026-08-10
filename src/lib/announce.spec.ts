import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ANNOUNCE_PAUSE_MS, createPoliteAnnouncer } from './announce';

/**
 * Every assertion here counts ANNOUNCEMENTS, not final state. That is the whole point: the two
 * failure modes design 1p names — a screen reader reading continuously, and one that says nothing —
 * both end on the correct final sentence. Only the number of rewrites tells them apart, and nothing
 * rendered on screen carries it.
 */
describe('createPoliteAnnouncer', () => {
	// Typed, not a bare `vi.fn()`: an untyped mock is assignable to nothing, and vitest strips types
	// so only `npm run check` ever sees it. This spec hit exactly that on its first run.
	let onChange: ReturnType<typeof vi.fn<(sentence: string) => void>>;

	beforeEach(() => {
		vi.useFakeTimers();
		onChange = vi.fn<(sentence: string) => void>();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function announcer(pauseMs?: number) {
		return createPoliteAnnouncer({ onChange, pauseMs });
	}

	it('says nothing at all until the pause has elapsed', () => {
		const a = announcer();
		a.schedule('Reste à répartir, 20,00 euros.');

		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS - 1);
		expect(onChange).not.toHaveBeenCalled();
		expect(a.announced).toBe('');

		vi.advanceTimersByTime(1);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(a.announced).toBe('Reste à répartir, 20,00 euros.');
	});

	it('typing « 8,00 » straight through produces ONE announcement, not four', () => {
		// The literal failure 1p describes: « 8, 80, 800, 80, 8 » read aloud while one number is
		// typed. Four keystrokes, 120ms apart, well inside the pause.
		const a = announcer();
		for (const sentence of [
			'Reste à répartir, 72,00 euros.',
			'Reste à répartir, 0,00 euros.',
			'Dépassement de 720,00 euros.',
			'Tout est réparti.'
		]) {
			a.schedule(sentence);
			vi.advanceTimersByTime(120);
		}
		expect(onChange).not.toHaveBeenCalled();

		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith('Tout est réparti.');
	});

	it('flush() announces immediately — the blur case — and consumes what was pending', () => {
		const a = announcer();
		a.schedule('Tout est réparti. Enregistrer est disponible.');
		a.flush();

		expect(onChange).toHaveBeenCalledTimes(1);

		// The pending timer must be dead, not merely overtaken: letting it fire would announce the
		// same sentence a second time, which is the "reads continuously" failure in miniature.
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS * 2);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('flush() with nothing pending is silent', () => {
		const a = announcer();
		a.flush();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('a sentence identical to the one announced is not repeated', () => {
		const a = announcer();
		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);

		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('typing a character and deleting it again stays silent, across a completed announcement', () => {
		// 1p: « Passer de 60,00 à 60,00 par une frappe puis un effacement ne parle pas. » The middle
		// sentence is never announced (it is inside the pause), and the third is identical to the
		// first, so the comparison must be against what was ANNOUNCED — not against the previous
		// schedule, which would find them different and speak.
		const a = announcer();
		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);

		a.schedule('Reste à répartir, 59,00 euros.');
		vi.advanceTimersByTime(100);
		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(a.announced).toBe('Reste à répartir, 60,00 euros.');
	});

	it('still announces a genuinely different sentence after a suppressed one', () => {
		// The suppression must not latch: a rule that goes quiet and stays quiet is the second
		// failure mode, and it is indistinguishable from the first on screen.
		const a = announcer();
		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);

		a.schedule('Reste à répartir, 60,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);

		a.schedule('Tout est réparti. Enregistrer est disponible.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);

		expect(onChange.mock.calls.map((c) => c[0])).toEqual([
			'Reste à répartir, 60,00 euros.',
			'Tout est réparti. Enregistrer est disponible.'
		]);
	});

	it('cancel() drops a pending sentence without announcing it', () => {
		const a = announcer();
		a.schedule('Dépassement de 5,00 euros.');
		a.cancel();
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS * 2);
		expect(onChange).not.toHaveBeenCalled();
		expect(a.announced).toBe('');
	});

	it('a flush after a cancel is silent, and a later schedule still works', () => {
		const a = announcer();
		a.schedule('Dépassement de 5,00 euros.');
		a.cancel();
		a.flush();
		expect(onChange).not.toHaveBeenCalled();

		a.schedule('Tout est réparti.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('each pause is measured from the LAST keystroke, not the first', () => {
		const a = announcer();
		a.schedule('a');
		vi.advanceTimersByTime(600);
		a.schedule('b');
		vi.advanceTimersByTime(600);
		// 1200ms since the first schedule, only 600 since the second: still silent.
		expect(onChange).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith('b');
	});

	it('treats an `initial` sentence as already announced, so opening a panel is silent', () => {
		// The region renders holding this text, which is why it must not be announced: a status
		// region created WITH content does not speak, one created empty and then filled does.
		const a = createPoliteAnnouncer({
			onChange,
			initial: 'Reste à répartir, 80,00 euros.'
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(a.announced).toBe('Reste à répartir, 80,00 euros.');

		// And the first state change re-scheduling that same sentence stays silent too — otherwise
		// touching a field and undoing it would announce the opening state as though it were new.
		a.schedule('Reste à répartir, 80,00 euros.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).not.toHaveBeenCalled();

		a.schedule('Tout est réparti. Enregistrer est disponible.');
		vi.advanceTimersByTime(ANNOUNCE_PAUSE_MS);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
