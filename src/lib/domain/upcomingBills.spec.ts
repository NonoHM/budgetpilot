import { describe, expect, it } from 'vitest';
import type { ForecastInputTransaction, RecurringFlow } from './forecast';
import { detectRecurringFlows, getCadenceToleranceDays, projectCashFlow } from './forecast';
import {
	normalizeRecurringLabel,
	normalizeStoredRecurringLabel,
	STORED_LABEL_MAX_CHARS
} from './recurrence';
import { formatMonthLabel } from './dateFormat';
import {
	actionMatchesFlow,
	applyStreamExclusions,
	buildBillOccurrences,
	computeOccurrenceStatus,
	computeStaleAfterDays,
	computeTotals,
	formatAmountRangeBounds,
	isStreamStale,
	listObservationCandidates,
	occurrenceActionWindowDays,
	type BillOccurrence,
	type StreamActionInput
} from './upcomingBills';

let nextTransactionId = 0;

function tx(
	overrides: Partial<ForecastInputTransaction> &
		Pick<ForecastInputTransaction, 'date' | 'label' | 'amountCents' | 'category'>
): ForecastInputTransaction {
	nextTransactionId += 1;
	return {
		id: `tx-${nextTransactionId}`,
		type: overrides.amountCents >= 0 ? 'income' : 'expense',
		...overrides
	};
}

function addDaysIso(iso: string, days: number): string {
	return new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

function flow(
	overrides: Partial<RecurringFlow> &
		Pick<RecurringFlow, 'label' | 'direction' | 'averageAmountCents' | 'lastDate'>
): RecurringFlow {
	const average = overrides.averageAmountCents;
	return {
		key: `${overrides.direction}:${normalizeRecurringLabel(overrides.label)}:Divers`,
		category: 'Divers',
		cadence: 'monthly',
		status: 'confirmed',
		confidence: 'high',
		occurrenceCount: 4,
		minAmountCents: average,
		maxAmountCents: average,
		medianIntervalDays: 30,
		intervalCoefficientOfVariation: 0,
		amountCoefficientOfVariation: 0,
		dayOfMonthConcentration: 1,
		anchorDayOfMonth: Number(overrides.lastDate.slice(8, 10)),
		occurrenceIds: [],
		...overrides
	};
}

function action(
	overrides: Partial<StreamActionInput> & Pick<StreamActionInput, 'kind'>
): StreamActionInput {
	return {
		id: `action-${overrides.kind}`,
		direction: 'expense',
		normalizedLabel: '',
		anchorTransactionIds: [],
		dueDate: null,
		...overrides
	};
}

describe('computeOccurrenceStatus', () => {
	it('never computes lateness for an uncertain stream, even 60 days in the past', () => {
		expect.assertions(2);

		const result = computeOccurrenceStatus('uncertain', '2026-06-01', '2026-07-31');

		expect(result.status).toBe('upcoming');
		expect(result.daysLate).toBeNull();
	});

	it('marks a confirmed stream dated 3 days before today as overdue', () => {
		expect.assertions(2);

		const result = computeOccurrenceStatus('confirmed', '2026-07-28', '2026-07-31');

		expect(result.status).toBe('overdue');
		expect(result.daysLate).toBe(3);
	});

	it('stays upcoming on the same day and in the future', () => {
		expect.assertions(4);

		const sameDay = computeOccurrenceStatus('confirmed', '2026-07-31', '2026-07-31');
		const future = computeOccurrenceStatus('likely', '2026-08-05', '2026-07-31');

		expect(sameDay.status).toBe('upcoming');
		expect(sameDay.daysLate).toBeNull();
		expect(future.status).toBe('upcoming');
		expect(future.daysLate).toBeNull();
	});
});

describe('occurrenceActionWindowDays', () => {
	it('bounds the window between 1 and 15 days around half the cadence', () => {
		expect.assertions(4);

		expect(occurrenceActionWindowDays({ medianIntervalDays: 7 })).toBe(3);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 30 })).toBe(15);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 365 })).toBe(15);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 1 })).toBe(1);
	});
});

describe('computeStaleAfterDays', () => {
	// The three worked examples the formula was fixed against: one cycle + the cadence's own
	// tolerance + one sigma of the stream's observed intervals, SUMMED (never maxed).
	it('sums the cadence, the cadence tolerance and one interval standard deviation', () => {
		expect.assertions(3);

		expect(
			computeStaleAfterDays({
				cadence: 'monthly',
				medianIntervalDays: 30,
				intervalCoefficientOfVariation: 0.1
			})
		).toBe(38);
		expect(
			computeStaleAfterDays({
				cadence: 'weekly',
				medianIntervalDays: 7,
				intervalCoefficientOfVariation: 0.1
			})
		).toBe(10);
		expect(
			computeStaleAfterDays({
				cadence: 'yearly',
				medianIntervalDays: 365,
				intervalCoefficientOfVariation: 0.05
			})
		).toBe(399);
	});

	// A plain change-detector on the five values, and nothing more: these literals ARE a copy of
	// CADENCE_WINDOWS, so re-hardcoding the table inside computeStaleAfterDays would leave this
	// green. It pins the numbers a reader of the formula expects; the test that actually binds the
	// tolerance to the detector's own behaviour is the one below it.
	it("reuses each cadence's tolerance without redeclaring it", () => {
		expect.assertions(5);

		const at = (cadence: RecurringFlow['cadence'], medianIntervalDays: number) =>
			computeStaleAfterDays({
				cadence,
				medianIntervalDays,
				intervalCoefficientOfVariation: 0
			}) - medianIntervalDays;

		expect(at('weekly', 7)).toBe(2);
		expect(at('biweekly', 14)).toBe(3);
		expect(at('monthly', 30)).toBe(5);
		expect(at('quarterly', 91)).toBe(10);
		expect(at('yearly', 365)).toBe(15);
	});

	/**
	 * The binding one: for every cadence, a stream whose interval is exactly
	 * `canonical period + getCadenceToleranceDays(cadence)` is still classified as that cadence by
	 * the detector, and one more day is classified as nothing at all. That is the detector's real
	 * acceptance boundary, observed rather than restated.
	 *
	 * This is what reddens if the tolerance is ever duplicated instead of read: widen
	 * `CADENCE_WINDOWS` while `getCadenceToleranceDays` keeps the old value and the `+ 1` case starts
	 * being detected; narrow it and the boundary case stops being detected. Only the canonical
	 * PERIODS are literals here, and those are the cadences' definition rather than the quantity
	 * under test.
	 */
	it('stays pinned to the window the detector actually accepts', () => {
		expect.assertions(10);

		const canonicalPeriodDays = [
			['weekly', 7],
			['biweekly', 14],
			['monthly', 30],
			['quarterly', 91],
			['yearly', 365]
		] as const;

		const detectAtInterval = (intervalDays: number) =>
			detectRecurringFlows(
				[0, 1, 2].map((step) =>
					tx({
						date: addDaysIso('2024-01-08', intervalDays * step),
						label: 'ABONNEMENT TEST',
						amountCents: -1_000,
						category: 'Divers'
					})
				)
			).map((detected) => detected.cadence);

		for (const [cadence, periodDays] of canonicalPeriodDays) {
			const tolerance = getCadenceToleranceDays(cadence);
			expect(detectAtInterval(periodDays + tolerance)).toEqual([cadence]);
			expect(detectAtInterval(periodDays + tolerance + 1)).toEqual([]);
		}
	});
});

describe('isStreamStale', () => {
	const monthly = {
		cadence: 'monthly',
		medianIntervalDays: 30,
		intervalCoefficientOfVariation: 0.1
	} as const;

	it('flips past the threshold, never right at it', () => {
		expect.assertions(3);

		// staleAfterDays = 38: a bill 8 days late must still read "En retard".
		expect(isStreamStale({ ...monthly, lastDate: '2026-06-27' }, '2026-07-31')).toBe(false);
		expect(isStreamStale({ ...monthly, lastDate: '2026-06-23' }, '2026-07-31')).toBe(false);
		expect(isStreamStale({ ...monthly, lastDate: '2026-06-22' }, '2026-07-31')).toBe(true);
	});
});

describe('actionMatchesFlow', () => {
	const target = flow({
		label: 'EDF PRELEVEMENT',
		direction: 'expense',
		averageAmountCents: 4890,
		lastDate: '2026-06-10',
		occurrenceIds: ['t1', 't2', 't3']
	});

	it('matches by anchored id even when the label does not match', () => {
		expect.assertions(1);

		expect(
			actionMatchesFlow(
				{
					direction: 'income',
					normalizedLabel: 'rien a voir',
					anchorTransactionIds: ['zzz', 't2']
				},
				target
			)
		).toBe(true);
	});

	/**
	 * The write path stores `normalizeRecurringLabel(truncateStoredLabel(label))`, so the matcher has
	 * to normalize the SAME truncated form. Normalizing the full label instead produces a different
	 * string for any label past the cap, and the visible symptom is a stream the user excluded
	 * silently reappearing once its anchors age out of the 12-month lookback.
	 *
	 * `Transaction.label` is `@db.Text` and bank connectors write provider labels through
	 * unmodified, so a label this long is reachable, not hypothetical.
	 */
	it('matches a stream whose label exceeds the storage bound', () => {
		expect.assertions(3);

		const longLabel = `Assurance habitation ${'x'.repeat(200)}`;
		expect(longLabel.length).toBeGreaterThan(STORED_LABEL_MAX_CHARS);

		const storedNormalizedLabel = normalizeStoredRecurringLabel(longLabel);
		// The bug this guards: the two normalizations genuinely differ for this label.
		expect(storedNormalizedLabel).not.toBe(normalizeRecurringLabel(longLabel));

		expect(
			actionMatchesFlow(
				{
					direction: 'expense',
					normalizedLabel: storedNormalizedLabel,
					anchorTransactionIds: ['aged-out']
				},
				flow({
					label: longLabel,
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-10',
					occurrenceIds: ['t9']
				})
			)
		).toBe(true);
	});

	it('falls back to the normalized label when no anchored id matches', () => {
		expect.assertions(1);

		expect(
			actionMatchesFlow(
				{
					direction: 'expense',
					normalizedLabel: normalizeRecurringLabel('edf prelevement'),
					anchorTransactionIds: ['zzz']
				},
				target
			)
		).toBe(true);
	});

	it('refuses an identical label in the wrong direction', () => {
		expect.assertions(2);

		expect(
			actionMatchesFlow(
				{
					direction: 'income',
					normalizedLabel: normalizeRecurringLabel('EDF PRELEVEMENT'),
					anchorTransactionIds: []
				},
				target
			)
		).toBe(false);
		expect(
			actionMatchesFlow(
				{ direction: 'expense', normalizedLabel: 'netflix', anchorTransactionIds: [] },
				target
			)
		).toBe(false);
	});
});

describe('applyStreamExclusions', () => {
	it('removes streams targeted by an exclude action and keeps the rest', () => {
		expect.assertions(2);

		const edf = flow({
			label: 'EDF',
			direction: 'expense',
			averageAmountCents: 4890,
			lastDate: '2026-06-10'
		});
		const netflix = flow({
			label: 'NETFLIX',
			direction: 'expense',
			averageAmountCents: 1349,
			lastDate: '2026-06-15'
		});

		const remaining = applyStreamExclusions(
			[edf, netflix],
			[
				action({ kind: 'exclude', normalizedLabel: normalizeRecurringLabel('EDF') }),
				action({ kind: 'ignore', normalizedLabel: normalizeRecurringLabel('NETFLIX') })
			]
		);

		expect(remaining).toHaveLength(1);
		expect(remaining[0].label).toBe('NETFLIX');
	});
});

describe('buildBillOccurrences', () => {
	it("leaves a past-due uncertain occurrence 'upcoming' while flagging the estimated date as passed", () => {
		expect.assertions(5);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'GYM CLUB',
					direction: 'expense',
					averageAmountCents: 1799,
					// Dated so the stream is not stale (see `isStreamStale`): its estimated date is past,
					// which is what this test is about, but the stream itself is still live and therefore
					// still projected.
					lastDate: '2026-06-28',
					status: 'tentative',
					occurrenceCount: 2
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].tier).toBe('uncertain');
		expect(occurrences[0].status).toBe('upcoming');
		expect(occurrences[0].daysLate).toBeNull();
		expect(occurrences[0].estimatePassed).toBe(true);
	});

	it('marks a past confirmed occurrence overdue with its day count', () => {
		expect.assertions(5);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].dateIso).toBe('2026-07-28');
		expect(occurrences[0].status).toBe('overdue');
		expect(occurrences[0].daysLate).toBe(3);
		expect(occurrences[0].estimatePassed).toBe(false);
	});

	it('marks a realized transaction as auto-settled, with no projected duplicate', () => {
		expect.assertions(8);

		const realized = tx({
			date: '2026-07-05',
			label: 'ABONNEMENT SALLE',
			amountCents: -3120,
			category: 'Loisirs'
		});

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'ABONNEMENT SALLE',
					direction: 'expense',
					averageAmountCents: 3000,
					lastDate: '2026-07-05',
					cadence: 'weekly',
					medianIntervalDays: 7,
					occurrenceIds: ['older-1', 'older-2', realized.id]
				})
			],
			transactions: [realized],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-06'
		});

		const dates = occurrences.map((occurrence) => occurrence.dateIso);

		expect(dates).toStrictEqual(['2026-07-05', '2026-07-12', '2026-07-19', '2026-07-26']);
		expect(new Set(dates).size).toBe(dates.length);
		expect(occurrences[0].status).toBe('settled');
		expect(occurrences[0].settledKind).toBe('auto');
		expect(occurrences[0].amountCents).toBe(-3120);
		expect(occurrences[0].settledTransactionId).toBe(realized.id);
		expect(occurrences[0].countsInRemainingTotal).toBe(false);
		expect(occurrences.filter((occurrence) => occurrence.settledKind === 'auto')).toHaveLength(1);
	});

	it("applies a 'paid' action inside the window and ignores the one outside it", () => {
		expect.assertions(8);

		const input = {
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-28',
					occurrenceIds: ['t1', 't2', 't3']
				})
			],
			transactions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		};

		const inside = buildBillOccurrences({
			...input,
			actions: [
				action({
					kind: 'paid',
					id: 'paid-inside',
					normalizedLabel: normalizeRecurringLabel('EDF'),
					dueDate: '2026-07-26'
				})
			]
		});
		const outside = buildBillOccurrences({
			...input,
			actions: [
				action({
					kind: 'paid',
					id: 'paid-outside',
					normalizedLabel: normalizeRecurringLabel('EDF'),
					dueDate: '2026-06-01'
				})
			]
		});

		expect(inside[0].status).toBe('settled');
		expect(inside[0].settledKind).toBe('manual');
		expect(inside[0].amountCents).toBe(-4890);
		expect(inside[0].appliedActionId).toBe('paid-inside');
		expect(inside[0].countsInRemainingTotal).toBe(false);
		expect(outside[0].status).toBe('overdue');
		expect(outside[0].appliedActionId).toBeNull();
		expect(outside[0].countsInRemainingTotal).toBe(true);
	});

	it("excludes from the total an occurrence targeted by an 'ignore' action", () => {
		expect.assertions(4);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [
				action({
					kind: 'ignore',
					id: 'ignore-1',
					normalizedLabel: normalizeRecurringLabel('EDF'),
					dueDate: '2026-07-28'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences[0].status).toBe('ignored');
		expect(occurrences[0].appliedActionId).toBe('ignore-1');
		expect(occurrences[0].countsInRemainingTotal).toBe(false);
		expect(computeTotals(occurrences).remainingExpenseCents).toBe(0);
	});

	it("produces no occurrence for a stream targeted by an 'exclude' action", () => {
		expect.assertions(1);

		const excluded = flow({
			label: 'EDF',
			direction: 'expense',
			averageAmountCents: 4890,
			lastDate: '2026-06-28',
			occurrenceIds: ['t1', 't2', 't3']
		});

		const occurrences = buildBillOccurrences({
			flows: [excluded],
			transactions: [
				tx({ id: 't3', date: '2026-07-02', label: 'EDF', amountCents: -4890, category: 'Divers' })
			],
			actions: [
				action({ kind: 'exclude', id: 'exclude-1', anchorTransactionIds: ['t3'], dueDate: null })
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences).toStrictEqual([]);
	});

	it('sorts by date then by label', () => {
		expect.assertions(1);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'ZETA',
					direction: 'expense',
					averageAmountCents: 1000,
					lastDate: '2026-06-10'
				}),
				flow({
					label: 'ALPHA',
					direction: 'expense',
					averageAmountCents: 2000,
					lastDate: '2026-06-10'
				}),
				flow({
					label: 'MIDDLE',
					direction: 'expense',
					averageAmountCents: 3000,
					lastDate: '2026-06-05'
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-01'
		});

		expect(
			occurrences.map((occurrence) => `${occurrence.dateIso}/${occurrence.flow.label}`)
		).toStrictEqual(['2026-07-05/MIDDLE', '2026-07-10/ALPHA', '2026-07-10/ZETA']);
	});

	it('never estimates an uncertain occurrence already settled by a real transaction', () => {
		expect.assertions(2);

		const realized = tx({
			date: '2026-07-05',
			label: 'GYM CLUB',
			amountCents: -1799,
			category: 'Loisirs'
		});

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'GYM CLUB',
					direction: 'expense',
					averageAmountCents: 1799,
					lastDate: '2026-07-05',
					status: 'tentative',
					occurrenceCount: 2,
					occurrenceIds: ['older-1', realized.id]
				})
			],
			transactions: [realized],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences[0].status).toBe('settled');
		// The row's date is a real transaction date, not an estimate, even though the flow is uncertain.
		expect(occurrences[0].estimatePassed).toBe(false);
	});

	it('includes a transaction dated exactly on the start bound and excludes one on the end bound', () => {
		expect.assertions(2);

		const onStart = tx({
			id: 'on-start',
			date: '2026-07-01',
			label: 'EDF',
			amountCents: -4890,
			category: 'Divers'
		});
		const onEnd = tx({
			id: 'on-end',
			date: '2026-08-01',
			label: 'EDF',
			amountCents: -4890,
			category: 'Divers'
		});

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-08-01',
					occurrenceIds: [onStart.id, onEnd.id]
				})
			],
			transactions: [onStart, onEnd],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		const settled = occurrences.filter((occurrence) => occurrence.status === 'settled');
		expect(settled).toHaveLength(1);
		expect(settled[0].settledTransactionId).toBe(onStart.id);
	});

	it('excludes a projected occurrence landing exactly on the exclusive end bound', () => {
		expect.assertions(1);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-07-01',
					cadence: 'monthly'
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-02',
			toIsoExclusive: '2026-07-31',
			todayIso: '2026-07-15'
		});

		// The flow's next monthly occurrence lands on 2026-07-31, i.e. exactly toIsoExclusive: dropped.
		expect(occurrences).toStrictEqual([]);
	});

	it('produces no projected occurrence for a degenerate period', () => {
		expect.assertions(1);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-15',
			toIsoExclusive: '2026-07-01',
			todayIso: '2026-07-15'
		});

		expect(occurrences).toStrictEqual([]);
	});

	it("settles only one occurrence when two 'paid' actions target the same date, the first wins", () => {
		expect.assertions(2);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [
				action({
					kind: 'paid',
					id: 'paid-first',
					normalizedLabel: normalizeRecurringLabel('EDF'),
					dueDate: '2026-07-27'
				}),
				action({
					kind: 'paid',
					id: 'paid-second',
					normalizedLabel: normalizeRecurringLabel('EDF'),
					dueDate: '2026-07-29'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].appliedActionId).toBe('paid-first');
	});

	it('matches an action by normalized label when no anchored id overlaps the stream', () => {
		expect.assertions(2);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'NETFLIX',
					direction: 'expense',
					averageAmountCents: 1349,
					lastDate: '2026-06-28',
					occurrenceIds: ['t1', 't2']
				})
			],
			transactions: [],
			actions: [
				action({
					kind: 'ignore',
					id: 'ignore-by-label',
					normalizedLabel: normalizeRecurringLabel('NETFLIX'),
					// No overlap at all with the flow's occurrenceIds — forces the label fallback.
					anchorTransactionIds: ['unrelated-1', 'unrelated-2'],
					dueDate: '2026-07-28'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences[0].status).toBe('ignored');
		expect(occurrences[0].appliedActionId).toBe('ignore-by-label');
	});

	it('settles only one occurrence of a biweekly stream when the due date falls exactly halfway between two projected dates', () => {
		expect.assertions(3);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'SALLE DE SPORT',
					direction: 'expense',
					averageAmountCents: 3000,
					lastDate: '2026-06-24',
					cadence: 'biweekly',
					medianIntervalDays: 14,
					occurrenceIds: ['t1', 't2', 't3']
				})
			],
			transactions: [],
			actions: [
				action({
					kind: 'paid',
					id: 'paid-midpoint',
					normalizedLabel: normalizeRecurringLabel('SALLE DE SPORT'),
					// Occurrences project to 2026-07-08 and 2026-07-22; window is 7 days either side —
					// this date is exactly 7 days from both.
					dueDate: '2026-07-15'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-01'
		});

		const settled = occurrences.filter((occurrence) => occurrence.status === 'settled');
		expect(occurrences.map((occurrence) => occurrence.dateIso)).toStrictEqual([
			'2026-07-08',
			'2026-07-22'
		]);
		expect(settled).toHaveLength(1);
		expect(settled[0].dateIso).toBe('2026-07-08');
	});
});

describe('computeTotals', () => {
	it('sums reliable expenses without netting income or counting the uncertain', () => {
		expect.assertions(2);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					lastDate: '2026-06-10'
				}),
				flow({
					label: 'NETFLIX',
					direction: 'expense',
					averageAmountCents: 1349,
					lastDate: '2026-06-15'
				}),
				flow({
					label: 'ASSURANCE AUTO',
					direction: 'expense',
					averageAmountCents: 4860,
					lastDate: '2026-06-20',
					confidence: 'medium'
				}),
				flow({
					label: 'GYM CLUB',
					direction: 'expense',
					averageAmountCents: 1799,
					lastDate: '2026-06-25',
					confidence: 'low'
				}),
				flow({
					label: 'SALAIRE',
					direction: 'income',
					averageAmountCents: 200_000,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-15'
		});

		const totals = computeTotals(occurrences);

		expect(totals.remainingExpenseCents).toBe(11_099);
		expect(totals.expectedIncomeCents).toBe(200_000);
	});

	it("uses the stream's average, not the realized amount, for a variable stream", () => {
		expect.assertions(1);

		const variable = flow({
			label: 'COURSES',
			direction: 'expense',
			averageAmountCents: 6000,
			minAmountCents: 4000,
			maxAmountCents: 9000,
			lastDate: '2026-06-12'
		});

		const totals = computeTotals(
			buildBillOccurrences({
				flows: [variable],
				transactions: [],
				actions: [],
				fromIso: '2026-07-01',
				toIsoExclusive: '2026-08-01',
				todayIso: '2026-07-01'
			})
		);

		expect(totals.remainingExpenseCents).toBe(6000);
	});

	it('returns zero totals when there is no occurrence', () => {
		expect.assertions(2);

		const totals = computeTotals([] as readonly BillOccurrence[]);

		expect(totals.remainingExpenseCents).toBe(0);
		expect(totals.expectedIncomeCents).toBe(0);
	});

	it('excludes settled, ignored or uncertain occurrences from both totals', () => {
		expect.assertions(2);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'EDF',
					direction: 'expense',
					averageAmountCents: 4890,
					// lastDate matches the realized transaction below (the flow's most recent occurrence),
					// so the projected series starts strictly after it and does not add a second row.
					lastDate: '2026-07-02',
					occurrenceIds: ['t1', 't2', 't3']
				}),
				flow({
					label: 'NETFLIX',
					direction: 'expense',
					averageAmountCents: 1349,
					lastDate: '2026-06-15',
					occurrenceIds: ['t4']
				}),
				flow({
					label: 'SALAIRE',
					direction: 'income',
					averageAmountCents: 200_000,
					lastDate: '2026-07-03',
					occurrenceIds: ['t5', 't6', 't7']
				}),
				flow({
					label: 'PRIME',
					direction: 'income',
					averageAmountCents: 50_000,
					lastDate: '2026-05-01',
					status: 'tentative',
					occurrenceCount: 2
				})
			],
			transactions: [
				// EDF settled automatically inside the period.
				tx({ id: 't3', date: '2026-07-02', label: 'EDF', amountCents: -4890, category: 'Divers' }),
				// SALAIRE settled automatically inside the period.
				tx({
					id: 't7',
					date: '2026-07-03',
					label: 'SALAIRE',
					amountCents: 200_000,
					category: 'Divers'
				})
			],
			actions: [
				action({
					kind: 'ignore',
					id: 'ignore-netflix',
					normalizedLabel: normalizeRecurringLabel('NETFLIX'),
					dueDate: '2026-07-15'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-20'
		});

		const totals = computeTotals(occurrences);

		// EDF is settled (excluded), NETFLIX is ignored (excluded): nothing left to pay.
		expect(totals.remainingExpenseCents).toBe(0);
		// SALAIRE is settled and PRIME is uncertain: neither counts as "expected" income anymore.
		expect(totals.expectedIncomeCents).toBe(0);
	});

	it("excludes from expected income an income occurrence targeted by an 'ignore' action", () => {
		expect.assertions(1);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'SALAIRE',
					direction: 'income',
					averageAmountCents: 200_000,
					lastDate: '2026-06-28'
				})
			],
			transactions: [],
			actions: [
				action({
					kind: 'ignore',
					id: 'ignore-salaire',
					direction: 'income',
					normalizedLabel: normalizeRecurringLabel('SALAIRE'),
					dueDate: '2026-07-28'
				})
			],
			fromIso: '2026-07-01',
			toIsoExclusive: '2026-08-01',
			todayIso: '2026-07-31'
		});

		expect(computeTotals(occurrences).expectedIncomeCents).toBe(0);
	});
});

describe('buildBillOccurrences — staleness guard', () => {
	const JULY = { fromIso: '2026-07-01', toIsoExclusive: '2026-08-01', todayIso: '2026-07-31' };

	/** Monthly, one sigma of interval spread at 10% -> staleAfterDays = 30 + 5 + 3 = 38. */
	function monthlyFlow(lastDate: string): RecurringFlow {
		return flow({
			label: 'NETFLIX',
			direction: 'expense',
			averageAmountCents: 1_399,
			lastDate,
			intervalCoefficientOfVariation: 0.1
		});
	}

	it('still projects, and overdue, a monthly bill silent for 34 days', () => {
		expect.assertions(4);

		const occurrences = buildBillOccurrences({
			flows: [monthlyFlow('2026-06-27')],
			transactions: [],
			actions: [],
			...JULY
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].dateIso).toBe('2026-07-27');
		expect(occurrences[0].status).toBe('overdue');
		expect(occurrences[0].daysLate).toBe(4);
	});

	/**
	 * The sentence the whole formula is shaped around, asserted end to end rather than on the
	 * predicate: at exactly `staleAfterDays` (38 for a monthly stream with CV 0.1) the row is still
	 * there and still reads "En retard", 8 days late. Summing the cadence tolerance and the CV term
	 * instead of maxing them is what buys those last 3 days — a `Math.max` gives 35 and this row
	 * disappears, taking a real unpaid bill off the user's schedule.
	 */
	it('keeps and flags overdue a monthly bill right at the threshold, 8 days late', () => {
		expect.assertions(4);

		const occurrences = buildBillOccurrences({
			flows: [monthlyFlow('2026-06-23')],
			transactions: [],
			actions: [],
			...JULY
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].dateIso).toBe('2026-07-23');
		expect(occurrences[0].status).toBe('overdue');
		expect(occurrences[0].daysLate).toBe(8);
	});

	it('stops projecting a monthly bill silent for 39 days, showing nothing', () => {
		expect.assertions(3);

		const occurrences = buildBillOccurrences({
			flows: [monthlyFlow('2026-06-22')],
			transactions: [],
			actions: [],
			...JULY
		});

		// Silent dropout: no row at all, so no status, no badge and no message key to carry.
		expect(occurrences).toEqual([]);
		expect(computeTotals(occurrences).remainingExpenseCents).toBe(0);
		expect(computeTotals(occurrences).expectedIncomeCents).toBe(0);
	});

	// The CV term is a real term, not decoration: at 36 days the same stream is kept or dropped
	// depending on its OWN observed regularity (35 vs 38 days of tolerance).
	it('grants more slack to an irregular stream than to a metronomic one', () => {
		expect.assertions(2);

		const regular = buildBillOccurrences({
			flows: [flow({ ...monthlyFlow('2026-06-25'), intervalCoefficientOfVariation: 0 })],
			transactions: [],
			actions: [],
			...JULY
		});
		const irregular = buildBillOccurrences({
			flows: [monthlyFlow('2026-06-25')],
			transactions: [],
			actions: [],
			...JULY
		});

		expect(regular).toEqual([]);
		expect(irregular).toHaveLength(1);
	});

	it('drops a weekly stream at 11 days and keeps the one at 10 days', () => {
		expect.assertions(2);

		// Weekly, CV 0.1 -> 7 + 2 + 1 = 10 days.
		const weekly = (lastDate: string) =>
			flow({
				label: 'CAFE',
				direction: 'expense',
				averageAmountCents: 350,
				lastDate,
				cadence: 'weekly',
				medianIntervalDays: 7,
				intervalCoefficientOfVariation: 0.1
			});

		expect(
			buildBillOccurrences({
				flows: [weekly('2026-07-21')],
				transactions: [],
				actions: [],
				...JULY
			})
		).toHaveLength(1);
		expect(
			buildBillOccurrences({
				flows: [weekly('2026-07-20')],
				transactions: [],
				actions: [],
				...JULY
			})
		).toEqual([]);
	});

	/**
	 * D2 (locked): an uncertain-tier stream can NEVER read "En retard" — `computeOccurrenceStatus`
	 * gates on the tier before any date arithmetic. The recency guard must not become a second
	 * lateness path: a stream that is both uncertain AND stale simply stops being projected.
	 *
	 * The live uncertain stream in the same call is what keeps this non-vacuous — without it, "no
	 * occurrence is overdue" would hold trivially over an empty list.
	 */
	it('makes a stale uncertain stream disappear without ever inventing lateness for it', () => {
		expect.assertions(5);

		const uncertain = (label: string, lastDate: string) =>
			flow({
				label,
				direction: 'expense',
				averageAmountCents: 1_799,
				lastDate,
				intervalCoefficientOfVariation: 0.1,
				status: 'tentative',
				occurrenceCount: 2
			});

		const occurrences = buildBillOccurrences({
			// Stale (39 days) and live (33 days), both uncertain, both with a past estimated date.
			flows: [uncertain('GYM PERIME', '2026-06-22'), uncertain('GYM ACTIF', '2026-06-28')],
			transactions: [],
			actions: [],
			...JULY
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].flow.label).toBe('GYM ACTIF');
		expect(occurrences[0].status).toBe('upcoming');
		expect(occurrences[0].estimatePassed).toBe(true);
		expect(occurrences.every((occurrence) => occurrence.status !== 'overdue')).toBe(true);
	});

	// The two cadences the arithmetic covers but no schedule did: biweekly (14 + 3 = 17) and
	// quarterly (91 + 10 = 101), each at its own boundary and one day past it.
	it("applies the biweekly and quarterly cadences' own thresholds", () => {
		expect.assertions(4);

		const stream = (
			cadence: RecurringFlow['cadence'],
			medianIntervalDays: number,
			lastDate: string
		) =>
			buildBillOccurrences({
				flows: [
					flow({
						label: 'ASSURANCE',
						direction: 'expense',
						averageAmountCents: 2_500,
						lastDate,
						cadence,
						medianIntervalDays
					})
				],
				transactions: [],
				actions: [],
				...JULY
			});

		expect(stream('biweekly', 14, '2026-07-14')).toHaveLength(1);
		expect(stream('biweekly', 14, '2026-07-13')).toEqual([]);
		expect(stream('quarterly', 91, '2026-04-21')).toHaveLength(1);
		expect(stream('quarterly', 91, '2026-04-20')).toEqual([]);
	});

	it('keeps a yearly bill silent for 380 days', () => {
		expect.assertions(2);

		// Yearly, CV 0.05 -> 365 + 15 + 19 = 399 days: a yearly bill is not written off after a year.
		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'ASSURANCE HABITATION',
					direction: 'expense',
					averageAmountCents: 18_000,
					lastDate: '2025-07-16',
					cadence: 'yearly',
					medianIntervalDays: 365,
					intervalCoefficientOfVariation: 0.05
				})
			],
			transactions: [],
			actions: [],
			...JULY
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].dateIso).toBe('2026-07-16');
	});

	it('keeps the realized occurrences of a stale stream, only the projection drops', () => {
		expect.assertions(4);

		// Weekly stream whose last transaction is 29 days old: stale (threshold 9), yet that
		// transaction really happened inside the period and stays.
		const realized = tx({
			date: '2026-07-02',
			label: 'CAFE',
			amountCents: -350,
			category: 'Divers'
		});

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'CAFE',
					direction: 'expense',
					averageAmountCents: 350,
					lastDate: '2026-07-02',
					cadence: 'weekly',
					medianIntervalDays: 7,
					occurrenceIds: ['older-1', 'older-2', realized.id]
				})
			],
			transactions: [realized],
			actions: [],
			...JULY
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].dateIso).toBe('2026-07-02');
		expect(occurrences[0].status).toBe('settled');
		expect(computeTotals(occurrences).remainingExpenseCents).toBe(0);
	});

	/**
	 * The guard lives in this module, NOT in `projectFlowOccurrences`, because the cash-flow forecast
	 * shares that function and is already correct: it projects a horizon from `todayIso`, so a stream
	 * that stopped months ago contributes nothing to it anyway. This asserts the forecast's output for
	 * a stream the upcoming-bills view now drops — same fixture, unchanged numbers.
	 */
	it('leaves the cash-flow forecast strictly unchanged for a stale stream', () => {
		expect.assertions(4);

		const stale = flow({
			label: 'CAFE',
			direction: 'expense',
			averageAmountCents: 5_000,
			lastDate: '2026-07-02',
			cadence: 'weekly',
			medianIntervalDays: 7
		});

		const forecastResult = projectCashFlow({
			confirmedFlows: [stale],
			residualDailyCents: 0,
			startingBalanceCents: 100_000,
			fromDate: '2026-07-31',
			horizonDays: 30
		});
		const eventDates = forecastResult.days
			.filter((day) => day.events.length > 0)
			.map((day) => day.date);

		// Exactly the values the forecast produced before the guard existed.
		expect(eventDates).toStrictEqual(['2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27']);
		expect(forecastResult.days[forecastResult.days.length - 1].balanceCents).toBe(
			100_000 - 4 * 5_000
		);
		expect(forecastResult.days).toHaveLength(31);
		// ...while the same flow is gone from the bills schedule.
		expect(
			buildBillOccurrences({ flows: [stale], transactions: [], actions: [], ...JULY })
		).toEqual([]);
	});
});

describe('listObservationCandidates', () => {
	it('surfaces a group of two unclassified transactions', () => {
		expect.assertions(2);

		const candidates = listObservationCandidates(
			[
				tx({ date: '2026-06-20', label: 'DENTISTE DUPONT', amountCents: -6500, category: 'Santé' }),
				tx({ date: '2026-07-20', label: 'Dentiste Dupont', amountCents: -6500, category: 'Santé' })
			],
			[]
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toStrictEqual({ label: 'Dentiste Dupont', occurrenceCount: 2 });
	});

	it('discards transactions already attached to a detected stream', () => {
		expect.assertions(1);

		const first = tx({
			date: '2026-06-15',
			label: 'NETFLIX',
			amountCents: -1349,
			category: 'Loisirs'
		});
		const second = tx({
			date: '2026-07-15',
			label: 'NETFLIX',
			amountCents: -1349,
			category: 'Loisirs'
		});

		const candidates = listObservationCandidates(
			[first, second],
			[
				flow({
					label: 'NETFLIX',
					direction: 'expense',
					averageAmountCents: 1349,
					lastDate: '2026-07-15',
					occurrenceIds: [first.id]
				})
			]
		);

		expect(candidates).toStrictEqual([]);
	});

	it('discards groups of three occurrences or more', () => {
		expect.assertions(1);

		const candidates = listObservationCandidates(
			[
				tx({ date: '2026-05-28', label: 'PHARMACIE', amountCents: -2000, category: 'Santé' }),
				tx({ date: '2026-06-28', label: 'PHARMACIE', amountCents: -2000, category: 'Santé' }),
				tx({ date: '2026-07-28', label: 'PHARMACIE', amountCents: -2000, category: 'Santé' })
			],
			[]
		);

		expect(candidates).toStrictEqual([]);
	});

	it('ranks by most recent transaction and caps at three', () => {
		expect.assertions(2);

		const candidates = listObservationCandidates(
			[
				tx({ date: '2026-06-20', label: 'DENTISTE', amountCents: -6500, category: 'Santé' }),
				tx({ date: '2026-07-20', label: 'DENTISTE', amountCents: -6500, category: 'Santé' }),
				tx({ date: '2026-05-10', label: 'GARAGE', amountCents: -12000, category: 'Transport' }),
				tx({ date: '2026-07-10', label: 'GARAGE', amountCents: -12000, category: 'Transport' }),
				tx({ date: '2026-06-05', label: 'PISCINE', amountCents: -3000, category: 'Loisirs' }),
				tx({ date: '2026-07-05', label: 'PISCINE', amountCents: -3000, category: 'Loisirs' }),
				tx({ date: '2026-06-01', label: 'CINEMA', amountCents: -1500, category: 'Loisirs' }),
				tx({ date: '2026-07-01', label: 'CINEMA', amountCents: -1500, category: 'Loisirs' })
			],
			[]
		);

		expect(candidates).toHaveLength(3);
		expect(candidates.map((candidate) => candidate.label)).toStrictEqual([
			'DENTISTE',
			'GARAGE',
			'PISCINE'
		]);
	});
});

// Both surfaces call this helper and neither had a direct test of it. The PREFIX locale is the half
// that was never exercised at all: `fr` puts the symbol last, so the `symbolLast` branch is the only
// one two component specs could reach.
describe('formatAmountRangeBounds', () => {
	it('keeps the symbol once — on the max in a suffix locale (fr)', () => {
		expect.assertions(4);

		const { min, max } = formatAmountRangeBounds(7_400, 9_600, '−', 'fr');

		expect(min).not.toContain('€');
		expect(max).toContain('€');
		// The sign stays on BOTH bounds: it is the only thing distinguishing a variable income from a
		// variable expense in text, and colour is not allowed to carry that alone.
		expect(min.startsWith('−')).toBe(true);
		expect(max.startsWith('−')).toBe(true);
	});

	it('keeps the symbol once — on the MIN in a prefix locale (en), the sign staying on both', () => {
		expect.assertions(5);

		const { min, max } = formatAmountRangeBounds(7_400, 9_600, '−', 'en');

		// `en` prints "€74", so the symbol moves to the bound it sits next to — the lower one.
		expect(min).toContain('€');
		expect(max).not.toContain('€');
		expect(min.startsWith('−')).toBe(true);
		expect(max.startsWith('−')).toBe(true);
		// One occurrence across the pair, never two.
		expect(`${min}${max}`.split('€').length - 1).toBe(1);
	});

	it('applies the positive sign as-is and rounds to the euro', () => {
		expect.assertions(2);

		const { min, max } = formatAmountRangeBounds(7_449, 9_649, '+', 'fr');

		expect(min.startsWith('+')).toBe(true);
		// Rounded to the euro on both bounds: a ",00 €" on an observed bound would assert a precision
		// that does not exist. `,` / `.` is left to Intl, so only the absence of decimals is pinned.
		expect(`${min}${max}`).not.toMatch(/[.,]\d/);
	});
});

describe('formatMonthLabel', () => {
	it('renders an ISO month as a localized long label', () => {
		expect.assertions(2);

		expect(formatMonthLabel('2026-07', 'fr')).toBe('juillet 2026');
		expect(formatMonthLabel('2026-01', 'en')).toBe('January 2026');
	});

	it('rejects a malformed month with an explicit error rather than letting Intl crash', () => {
		expect.assertions(2);

		expect(() => formatMonthLabel('2026-13', 'fr')).toThrow(RangeError);
		expect(() => formatMonthLabel('', 'fr')).toThrow(RangeError);
	});
});
