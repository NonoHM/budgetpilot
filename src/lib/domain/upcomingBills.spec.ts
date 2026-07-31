import { describe, expect, it } from 'vitest';
import type { ForecastInputTransaction, RecurringFlow } from './forecast';
import { normalizeRecurringLabel } from './recurrence';
import { formatMonthLabel } from './dateFormat';
import {
	actionMatchesFlow,
	applyStreamExclusions,
	buildBillOccurrences,
	computeOccurrenceStatus,
	computeTotals,
	getLabelInitials,
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

	it('ignore les échéances réglées et sans occurrence', () => {
		expect.assertions(2);

		const totals = computeTotals([] as readonly BillOccurrence[]);

		expect(totals.remainingExpenseCents).toBe(0);
		expect(totals.expectedIncomeCents).toBe(0);
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

describe('getLabelInitials', () => {
	it('dérive des initiales déterministes selon le nombre de mots', () => {
		expect.assertions(4);

		expect(getLabelInitials('EDF')).toBe('EDF');
		expect(getLabelInitials('Netflix')).toBe('NE');
		expect(getLabelInitials('Assurance auto')).toBe('AA');
		expect(getLabelInitials('   ')).toBe('');
	});
});

describe('formatMonthLabel', () => {
	it('rend un mois ISO en libellé long localisé', () => {
		expect.assertions(2);

		expect(formatMonthLabel('2026-07', 'fr')).toBe('juillet 2026');
		expect(formatMonthLabel('2026-01', 'en')).toBe('January 2026');
	});
});
