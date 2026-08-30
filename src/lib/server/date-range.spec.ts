import { describe, expect, it } from 'vitest';
import { parseCustomDateRange, parseDateRange, serializePeriodParams } from './date-range';
import {
	REPORTING_PERIOD_PRESET_IDS,
	periodKeyOfPreset,
	periodPresetRange,
	periodQueryOfRange
} from '$lib/domain/periodPresets';

const now = new Date('2026-06-25T10:00:00.000Z');

describe('parseDateRange', () => {
	it('retourne le mois courant par défaut', () => {
		expect.assertions(4);

		const range = parseDateRange(new URLSearchParams(), now);

		expect(range.key).toBe('this-month');
		expect(range.from).toEqual(new Date('2026-06-01T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-07-01T00:00:00.000Z'));
		expect(range.budgetMonth).toBe('2026-06');
	});

	it('retourne le mois dernier', () => {
		expect.assertions(3);

		const range = parseDateRange(new URLSearchParams('period=last-month'), now);

		expect(range.key).toBe('last-month');
		expect(range.fromDate).toBe('2026-05-01');
		expect(range.toDate).toBe('2026-05-31');
	});

	it('inclut les 30 derniers jours avec une borne haute exclusive', () => {
		expect.assertions(3);

		const range = parseDateRange(new URLSearchParams('period=last-30-days'), now);

		expect(range.from).toEqual(new Date('2026-05-27T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-06-26T00:00:00.000Z'));
		expect(range.label).toBe('30 derniers jours');
	});

	it('retourne une période all-time sans borne basse effective', () => {
		expect.assertions(5);

		const range = parseDateRange(new URLSearchParams('period=all-time'), now);

		expect(range.key).toBe('all-time');
		expect(range.from).toEqual(new Date(0));
		expect(range.to).toEqual(new Date('2026-06-26T00:00:00.000Z'));
		expect(range.label).toBe('Toujours');
		// Never a whole calendar month → the budget summary stays unavailable downstream.
		expect(range.comparisonMonth).toBeUndefined();
	});

	it("all-time n'a pas de borne de durée", () => {
		expect.assertions(1);

		const range = parseDateRange(new URLSearchParams('period=all-time'), now);
		const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;

		expect(days).toBeGreaterThan(731);
	});

	it('accepte une période personnalisée de plus de 731 jours (aucun plafond)', () => {
		expect.assertions(1);

		const range = parseDateRange(
			new URLSearchParams('period=custom&from=2020-01-01&to=2026-06-10'),
			now
		);

		expect(range.key).toBe('custom');
	});

	it('valide une période personnalisée', () => {
		expect.assertions(4);

		const range = parseDateRange(
			new URLSearchParams('period=custom&from=2026-05-20&to=2026-06-10'),
			now
		);

		expect(range.key).toBe('custom');
		expect(range.from).toEqual(new Date('2026-05-20T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-06-11T00:00:00.000Z'));
		expect(range.budgetMonth).toBe('2026-05');
	});

	it('refuse une période personnalisée invalide (from après to)', () => {
		expect.assertions(1);

		expect(() =>
			parseDateRange(new URLSearchParams('period=custom&from=2026-06-10&to=2026-06-01'), now)
		).toThrow();
	});
});

describe('parseCustomDateRange — hostile and shape-valid-but-impossible input', () => {
	/**
	 * These are all values that PASS the `^\d{4}-\d{2}-\d{2}$` shape check, because that pattern
	 * counts digits and does not read a calendar. Each one used to reach `Date.prototype.toISOString`
	 * on an `Invalid Date`, which THROWS `RangeError` rather than returning a sentinel — and that
	 * throw escaped `parseTransactionDateRange`'s catch (it re-raises anything that is not an
	 * HttpError), so /transactions answered 500 instead of rendering its "Période invalide" state.
	 *
	 * Reachable by TYPING, not only by editing the URL: the Période panel's "Du" field accepts
	 * 99/99/2026 and navigates to ?from=2026-99-99.
	 */
	it.each(['2026-99-99', '2026-13-01', '2026-00-00', '2026-06-00'])(
		'rejects %s with a 400 rather than throwing a RangeError',
		(value) => {
			// The assertion is about the CLASS of failure, not merely that it fails: a RangeError here
			// would also make `toThrow()` pass, which is why the status is checked.
			expect(() => parseCustomDateRange(value, '2026-12-31')).toThrowError(
				expect.objectContaining({ status: 400 })
			);
			expect(() => parseCustomDateRange('2026-01-01', value)).toThrowError(
				expect.objectContaining({ status: 400 })
			);
		}
	);

	it('still rejects a rolled-over date, which was never the broken case', () => {
		// 2026-02-30 rolls over to March 2 — a VALID Date — so it always reached the round-trip and was
		// correctly refused as non-canonical. Pinned so the NaN guard is not mistaken for what catches
		// it, and so removing the round-trip check does not go unnoticed.
		expect(() => parseCustomDateRange('2026-02-30', '2026-12-31')).toThrowError(
			expect.objectContaining({ status: 400 })
		);
	});

	it('accepts a real range', () => {
		const range = parseCustomDateRange('2026-06-01', '2026-06-30');
		expect(range.fromDate).toBe('2026-06-01');
		expect(range.toDate).toBe('2026-06-30');
	});
});

describe('the preset block and the period keys name the same ranges', () => {
	/**
	 * The one test that stops the two halves of #547 drifting apart, and it is written as a
	 * COMPARISON OF TWO REAL FUNCTIONS rather than against a table of dates typed here: a table
	 * would be a third source, and the two sides would be free to agree with it and not with each
	 * other.
	 *
	 * It separates "a preset button writes the range its period key resolves to" from "the button
	 * writes a range that merely looks right". The second is invisible on screen, because both
	 * produce a filled panel and a plausible label, and it shows up only as figures computed over
	 * the wrong days.
	 *
	 * `toDate` rather than `to`: `buildRange` stores the exclusive bound in `to` and the inclusive
	 * one in `toDate`, and the preset module speaks inclusive throughout.
	 */
	const todayIso = now.toISOString().slice(0, 10);

	for (const id of REPORTING_PERIOD_PRESET_IDS) {
		const key = periodKeyOfPreset(id);

		it(`${id} writes the same range as ?period=${key}`, () => {
			expect.assertions(3);
			expect(key).not.toBeNull();

			const fromTheKey = parseDateRange(new URLSearchParams(`period=${key}`), now);
			const fromThePreset = periodPresetRange(id, todayIso);

			expect(fromThePreset.from).toBe(fromTheKey.fromDate);
			expect(fromThePreset.to).toBe(fromTheKey.toDate);
		});
	}
});

describe('the client serialiser and the server serialiser agree', () => {
	/**
	 * `periodQueryOfRange` runs in the browser when a preset is applied; `serializePeriodParams`
	 * runs on the server to rebuild the current period's query for links on the page. If they
	 * disagree, a period applied from the panel and the same period linked from the page point at
	 * different URLs, and only one of them carries `comparisonMonth`.
	 *
	 * Compared as two REAL functions rather than against a table of expected strings, so neither is
	 * free to agree with a third source and not with the other.
	 *
	 * Separates "the two spellings of a period are the same string" from "they differ by a param
	 * that only one screen sends".
	 */
	const todayIso = now.toISOString().slice(0, 10);

	for (const id of REPORTING_PERIOD_PRESET_IDS) {
		it(`${id} serialises the same on both sides`, () => {
			expect.assertions(1);
			const fromTheServer = serializePeriodParams(
				parseDateRange(new URLSearchParams(`period=${periodKeyOfPreset(id)}`), now)
			);

			expect(
				periodQueryOfRange(periodPresetRange(id, todayIso), todayIso, REPORTING_PERIOD_PRESET_IDS)
			).toBe(fromTheServer);
		});
	}
});
