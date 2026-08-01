import { describe, expect, it } from 'vitest';
import type { ForecastInputTransaction, RecurringFlow } from './forecast';
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
	computeTotals,
	formatAmountRangeBounds,
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
	it('ne calcule jamais de retard pour un flux incertain, même 60 jours dans le passé', () => {
		expect.assertions(2);

		const result = computeOccurrenceStatus('uncertain', '2026-06-01', '2026-07-31');

		expect(result.status).toBe('upcoming');
		expect(result.daysLate).toBeNull();
	});

	it('marque en retard un flux confirmé daté de 3 jours avant aujourd’hui', () => {
		expect.assertions(2);

		const result = computeOccurrenceStatus('confirmed', '2026-07-28', '2026-07-31');

		expect(result.status).toBe('overdue');
		expect(result.daysLate).toBe(3);
	});

	it('reste à venir le jour même et dans le futur', () => {
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
	it('borne la fenêtre entre 1 et 15 jours autour de la moitié de la cadence', () => {
		expect.assertions(4);

		expect(occurrenceActionWindowDays({ medianIntervalDays: 7 })).toBe(3);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 30 })).toBe(15);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 365 })).toBe(15);
		expect(occurrenceActionWindowDays({ medianIntervalDays: 1 })).toBe(1);
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

	it('associe par identifiant ancré même quand le libellé ne correspond pas', () => {
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
	it('associe un flux dont le libellé dépasse la borne de stockage', () => {
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

	it('retombe sur le libellé normalisé quand aucun identifiant ancré ne correspond', () => {
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

	it('refuse un libellé identique dans la mauvaise direction', () => {
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
	it('retire les flux visés par une action exclude et garde les autres', () => {
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
	it("laisse une échéance incertaine dépassée en 'à venir' tout en signalant la date estimée passée", () => {
		expect.assertions(5);

		const occurrences = buildBillOccurrences({
			flows: [
				flow({
					label: 'GYM CLUB',
					direction: 'expense',
					averageAmountCents: 1799,
					lastDate: '2026-05-01',
					status: 'tentative',
					occurrenceCount: 2
				})
			],
			transactions: [],
			actions: [],
			fromIso: '2026-06-01',
			toIsoExclusive: '2026-07-01',
			todayIso: '2026-07-31'
		});

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].tier).toBe('uncertain');
		expect(occurrences[0].status).toBe('upcoming');
		expect(occurrences[0].daysLate).toBeNull();
		expect(occurrences[0].estimatePassed).toBe(true);
	});

	it('marque une échéance confirmée passée en retard avec son nombre de jours', () => {
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

	it('marque une transaction réalisée comme réglée automatiquement, sans doublon projeté', () => {
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

	it("applique une action 'paid' dans la fenêtre et ignore celle qui est hors fenêtre", () => {
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

	it("exclut du total une échéance visée par une action 'ignore'", () => {
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

	it("ne produit aucune échéance pour un flux visé par une action 'exclude'", () => {
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

	it('trie par date puis par libellé', () => {
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

	it('n’estime jamais une échéance incertaine déjà réglée par une vraie transaction', () => {
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

	it('inclut une transaction datée exactement sur la borne de début et exclut celle sur la borne de fin', () => {
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

	it('exclut une occurrence projetée tombant exactement sur la borne de fin exclusive', () => {
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

	it('ne produit aucune occurrence projetée pour une période dégénérée', () => {
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

	it("règle une seule occurrence quand deux actions 'paid' visent la même date, la première l'emporte", () => {
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

	it('associe une action par le libellé normalisé quand aucun identifiant ancré ne recoupe le flux', () => {
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

	it("règle une seule occurrence d'un flux bimensuel quand l'échéance tombe exactement à mi-chemin entre deux dates projetées", () => {
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
	it("somme les dépenses fiables sans nettoyer les revenus ni compter l'incertain", () => {
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

	it('utilise la moyenne du flux et non le montant réalisé pour un flux variable', () => {
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

	it('retourne des totaux nuls quand il n’y a aucune occurrence', () => {
		expect.assertions(2);

		const totals = computeTotals([] as readonly BillOccurrence[]);

		expect(totals.remainingExpenseCents).toBe(0);
		expect(totals.expectedIncomeCents).toBe(0);
	});

	it('exclut les échéances réglées, ignorées ou incertaines des deux totaux', () => {
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

	it("exclut du revenu attendu une échéance de revenu visée par une action 'ignore'", () => {
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

describe('listObservationCandidates', () => {
	it('remonte un groupe de deux transactions non classées', () => {
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

	it('écarte les transactions déjà rattachées à un flux détecté', () => {
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

	it('écarte les groupes de trois occurrences ou plus', () => {
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

	it('classe par transaction la plus récente et plafonne à trois', () => {
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
	it('garde le symbole une seule fois — sur le max en locale suffixe (fr)', () => {
		expect.assertions(4);

		const { min, max } = formatAmountRangeBounds(7_400, 9_600, '−', 'fr');

		expect(min).not.toContain('€');
		expect(max).toContain('€');
		// The sign stays on BOTH bounds: it is the only thing distinguishing a variable income from a
		// variable expense in text, and colour is not allowed to carry that alone.
		expect(min.startsWith('−')).toBe(true);
		expect(max.startsWith('−')).toBe(true);
	});

	it('garde le symbole une seule fois — sur le MIN en locale préfixe (en), le signe restant sur les deux', () => {
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

	it("applique le signe positif tel quel et arrondit à l'euro", () => {
		expect.assertions(2);

		const { min, max } = formatAmountRangeBounds(7_449, 9_649, '+', 'fr');

		expect(min.startsWith('+')).toBe(true);
		// Rounded to the euro on both bounds: a ",00 €" on an observed bound would assert a precision
		// that does not exist. `,` / `.` is left to Intl, so only the absence of decimals is pinned.
		expect(`${min}${max}`).not.toMatch(/[.,]\d/);
	});
});

describe('formatMonthLabel', () => {
	it('rend un mois ISO en libellé long localisé', () => {
		expect.assertions(2);

		expect(formatMonthLabel('2026-07', 'fr')).toBe('juillet 2026');
		expect(formatMonthLabel('2026-01', 'en')).toBe('January 2026');
	});

	it('rejette un mois malformé avec une erreur explicite plutôt que de laisser Intl planter', () => {
		expect.assertions(2);

		expect(() => formatMonthLabel('2026-13', 'fr')).toThrow(RangeError);
		expect(() => formatMonthLabel('', 'fr')).toThrow(RangeError);
	});
});
