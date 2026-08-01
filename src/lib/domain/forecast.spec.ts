import { describe, expect, it } from 'vitest';
import type { Transaction } from './transaction';
import {
	buildDenseDailyNetSeries,
	buildRealizedLedgerDays,
	computeResidualDailyCents,
	detectionEndExclusive,
	detectRecurringFlows,
	getFlowAmountVariability,
	getFlowDisplayTier,
	getRemainingDaysInMonthUtc,
	hasReliableConfirmedFlow,
	isReliableConfirmedFlow,
	projectCashFlow,
	projectFlowOccurrences,
	type RecurringFlow
} from './forecast';

let nextId = 0;

function tx(
	overrides: Partial<Transaction> & Pick<Transaction, 'date' | 'label' | 'amountCents' | 'category'>
): Transaction {
	nextId += 1;
	return {
		id: `tx-${nextId}`,
		source: 'csv',
		type: overrides.amountCents >= 0 ? 'income' : 'expense',
		...overrides
	};
}

describe('detectRecurringFlows', () => {
	it('détecte un salaire mensuel régulier avec une confiance haute', () => {
		expect.assertions(7);

		const dates = [
			'2025-01-28',
			'2025-02-28',
			'2025-03-28',
			'2025-04-28',
			'2025-05-28',
			'2025-06-28',
			'2025-07-28',
			'2025-08-28',
			'2025-09-28',
			'2025-10-28',
			'2025-11-28',
			'2025-12-28'
		];
		const transactions = dates.map((date) =>
			tx({ date, label: 'VIREMENT SALAIRE ACME', amountCents: 200_000, category: 'Revenus' })
		);

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].direction).toBe('income');
		expect(flows[0].cadence).toBe('monthly');
		expect(flows[0].status).toBe('confirmed');
		expect(flows[0].confidence).toBe('high');
		expect(flows[0].occurrenceCount).toBe(12);
		expect(flows[0].occurrenceIds).toEqual(transactions.map((transaction) => transaction.id));
	});

	it('détecte un loyer avec jitter (jour et montant légèrement variables) sans casser la cadence mensuelle', () => {
		expect.assertions(4);

		const days = ['03', '04', '02', '05', '03', '01', '03', '04', '02', '05', '03', '04'];
		const amounts = [
			80_000, 80_500, 79_600, 80_200, 80_000, 79_800, 80_300, 80_100, 79_700, 80_400, 80_000, 80_200
		];
		const transactions = days.map((day, index) =>
			tx({
				date: `2025-${String(index + 1).padStart(2, '0')}-${day}`,
				label: 'PRELEVEMENT LOYER',
				amountCents: -amounts[index],
				category: 'Logement'
			})
		);

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].direction).toBe('expense');
		expect(flows[0].cadence).toBe('monthly');
		expect(flows[0].confidence).not.toBe('low');
	});

	it('rejette une dépense ponctuelle regroupée à tort par montant (intervalle hors fenêtre de cadence)', () => {
		expect.assertions(1);

		const transactions = [
			tx({
				date: '2025-01-05',
				label: 'AUCHAN PARIS',
				amountCents: -4_200,
				category: 'Alimentation'
			}),
			// 47 jours plus tard : ni mensuel (max 35j), ni trimestriel (min 81j) — zone morte volontaire.
			tx({
				date: '2025-02-21',
				label: 'AUCHAN PARIS',
				amountCents: -4_250,
				category: 'Alimentation'
			})
		];

		expect(detectRecurringFlows(transactions)).toHaveLength(0);
	});

	it('détecte une cadence hebdomadaire confirmée', () => {
		expect.assertions(3);

		const dates = [
			'2025-01-06',
			'2025-01-13',
			'2025-01-20',
			'2025-01-27',
			'2025-02-03',
			'2025-02-10'
		];
		const transactions = dates.map((date) =>
			tx({ date, label: 'ABONNEMENT SPORT CLUB', amountCents: -1_500, category: 'Sport' })
		);

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].cadence).toBe('weekly');
		expect(flows[0].status).toBe('confirmed');
	});

	it('classe un loyer mensuel à dates réalistes et espacées (pas de doublon même-jour) comme monthly, jamais weekly', () => {
		expect.assertions(3);

		const dates = ['2025-05-17', '2025-06-17', '2025-07-17'];
		const transactions = dates.map((date) =>
			tx({ date, label: 'PRELEVEMENT LOYER', amountCents: -75_000, category: 'Logement' })
		);

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].cadence).toBe('monthly');
		expect(flows[0].status).toBe('confirmed');
	});

	it('classe 2 occurrences comme tentative, jamais confirmée', () => {
		expect.assertions(3);

		const transactions = [
			tx({
				date: '2025-01-15',
				label: 'ASSURANCE HABITATION',
				amountCents: -3_500,
				category: 'Assurance'
			}),
			tx({
				date: '2025-02-14',
				label: 'ASSURANCE HABITATION',
				amountCents: -3_500,
				category: 'Assurance'
			})
		];

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].cadence).toBe('monthly');
		expect(flows[0].status).toBe('tentative');
	});

	it('ne peut jamais confirmer une cadence annuelle avec seulement 2 occurrences (limite du lookback 12 mois)', () => {
		expect.assertions(3);

		// 3 occurrences confirmées d'un flux annuel exigeraient ~24 mois d'historique — hors de
		// portée du lookback de 12 mois retenu pour le forecast (server/forecast, étape 3).
		const transactions = [
			tx({
				date: '2024-03-01',
				label: 'ASSURANCE AUTO ANNUELLE',
				amountCents: -42_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-03-01',
				label: 'ASSURANCE AUTO ANNUELLE',
				amountCents: -42_000,
				category: 'Assurance'
			})
		];

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].cadence).toBe('yearly');
		expect(flows[0].status).toBe('tentative');
	});

	it('reste classé mensuel malgré la variation de longueur des mois (28/29/30/31 jours)', () => {
		expect.assertions(3);

		// Payé le dernier jour de chaque mois : l'intervalle réel varie de 28 à 31 jours.
		const dates = [
			'2025-01-31',
			'2025-02-28',
			'2025-03-31',
			'2025-04-30',
			'2025-05-31',
			'2025-06-30',
			'2025-07-31',
			'2025-08-31',
			'2025-09-30',
			'2025-10-31',
			'2025-11-30',
			'2025-12-31'
		];
		const transactions = dates.map((date) =>
			tx({ date, label: 'LOYER FIN DE MOIS', amountCents: -90_000, category: 'Logement' })
		);

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(1);
		expect(flows[0].cadence).toBe('monthly');
		expect(flows[0].status).toBe('confirmed');
	});

	it('ne mélange jamais un revenu et une dépense du même marchand/catégorie dans un même flux', () => {
		expect.assertions(2);

		const transactions = [
			tx({
				date: '2025-01-10',
				label: 'REMBOURSEMENT ASSURANCE',
				amountCents: 5_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-02-10',
				label: 'REMBOURSEMENT ASSURANCE',
				amountCents: 5_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-03-10',
				label: 'REMBOURSEMENT ASSURANCE',
				amountCents: 5_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-01-15',
				label: 'PRIME ASSURANCE',
				amountCents: -5_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-02-15',
				label: 'PRIME ASSURANCE',
				amountCents: -5_000,
				category: 'Assurance'
			}),
			tx({
				date: '2025-03-15',
				label: 'PRIME ASSURANCE',
				amountCents: -5_000,
				category: 'Assurance'
			})
		];

		const flows = detectRecurringFlows(transactions);

		expect(flows).toHaveLength(2);
		expect(new Set(flows.map((flow) => flow.direction))).toEqual(new Set(['income', 'expense']));
	});

	it('ignore les libellés qui ne contiennent aucune matière normalisable', () => {
		expect.assertions(1);

		const transactions = [
			tx({ date: '2025-01-01', label: '123456', amountCents: -1_000, category: 'Autre' }),
			tx({ date: '2025-02-01', label: '789012', amountCents: -1_000, category: 'Autre' })
		];

		expect(detectRecurringFlows(transactions)).toHaveLength(0);
	});
});

function flow(
	overrides: Partial<RecurringFlow> &
		Pick<RecurringFlow, 'cadence' | 'direction' | 'lastDate' | 'anchorDayOfMonth'>
): RecurringFlow {
	return {
		key: 'expense:test:Test',
		label: 'Test',
		category: 'Test',
		status: 'confirmed',
		confidence: 'high',
		occurrenceCount: 3,
		averageAmountCents: 10_000,
		minAmountCents: 10_000,
		maxAmountCents: 10_000,
		medianIntervalDays: 30,
		intervalCoefficientOfVariation: 0,
		amountCoefficientOfVariation: 0,
		dayOfMonthConcentration: 1,
		occurrenceIds: [],
		...overrides
	};
}

describe('projectFlowOccurrences', () => {
	it("projette un flux mensuel en clampant l'ancre de fin de mois (31 -> 28/29/30)", () => {
		expect.assertions(4);

		const monthlyFlow = flow({
			cadence: 'monthly',
			direction: 'expense',
			lastDate: '2025-01-31',
			anchorDayOfMonth: 31,
			averageAmountCents: 90_000
		});

		const occurrences = projectFlowOccurrences(monthlyFlow, '2025-02-01', 90);

		expect(occurrences.map((o) => o.date)).toEqual(['2025-02-28', '2025-03-31', '2025-04-30']);
		expect(occurrences[0].amountCents).toBe(-90_000);
		expect(occurrences.every((o) => o.cadence === 'monthly')).toBe(true);
		expect(occurrences.every((o) => o.flowLabel === 'Test')).toBe(true);
	});

	it('clampe sur février bissextile (29 jours en 2028)', () => {
		expect.assertions(1);

		const monthlyFlow = flow({
			cadence: 'monthly',
			direction: 'expense',
			lastDate: '2028-01-31',
			anchorDayOfMonth: 31
		});

		const occurrences = projectFlowOccurrences(monthlyFlow, '2028-02-01', 31);

		expect(occurrences.map((o) => o.date)).toEqual(['2028-02-29']);
	});

	it('projette un flux hebdomadaire par pas fixe de 7 jours', () => {
		expect.assertions(1);

		const weeklyFlow = flow({
			cadence: 'weekly',
			direction: 'expense',
			lastDate: '2025-01-06',
			anchorDayOfMonth: 6
		});

		const occurrences = projectFlowOccurrences(weeklyFlow, '2025-01-07', 21);

		expect(occurrences.map((o) => o.date)).toEqual(['2025-01-13', '2025-01-20', '2025-01-27']);
	});

	it('projette un flux trimestriel et annuel par pas calendaires', () => {
		expect.assertions(2);

		const quarterlyFlow = flow({
			cadence: 'quarterly',
			direction: 'expense',
			lastDate: '2025-01-15',
			anchorDayOfMonth: 15
		});
		const yearlyFlow = flow({
			cadence: 'yearly',
			direction: 'expense',
			lastDate: '2025-01-15',
			anchorDayOfMonth: 15
		});

		expect(projectFlowOccurrences(quarterlyFlow, '2025-01-16', 200).map((o) => o.date)).toEqual([
			'2025-04-15',
			'2025-07-15'
		]);
		expect(projectFlowOccurrences(yearlyFlow, '2025-01-16', 400).map((o) => o.date)).toEqual([
			'2026-01-15'
		]);
	});

	it('applique le signe de la direction (revenu positif, dépense négative)', () => {
		expect.assertions(2);

		const incomeFlow = flow({
			cadence: 'monthly',
			direction: 'income',
			lastDate: '2025-01-28',
			anchorDayOfMonth: 28,
			averageAmountCents: 200_000
		});
		const expenseFlow = flow({
			cadence: 'monthly',
			direction: 'expense',
			lastDate: '2025-01-28',
			anchorDayOfMonth: 28,
			averageAmountCents: 80_000
		});

		expect(projectFlowOccurrences(incomeFlow, '2025-02-01', 30)[0].amountCents).toBe(200_000);
		expect(projectFlowOccurrences(expenseFlow, '2025-02-01', 30)[0].amountCents).toBe(-80_000);
	});

	it("exclut une occurrence tombant juste après l'horizon, inclut celle tombant pile dessus", () => {
		expect.assertions(2);

		const monthlyFlow = flow({
			cadence: 'monthly',
			direction: 'expense',
			lastDate: '2025-01-28',
			anchorDayOfMonth: 28
		});

		// 2025-02-28 est exactement à 27 jours de 2025-02-01.
		expect(projectFlowOccurrences(monthlyFlow, '2025-02-01', 27).map((o) => o.date)).toEqual([
			'2025-02-28'
		]);
		expect(projectFlowOccurrences(monthlyFlow, '2025-02-01', 26)).toHaveLength(0);
	});
});

describe('projectCashFlow', () => {
	it('cumule salaire mensuel confirmé, loyer mensuel confirmé et résiduel journalier sur un horizon de 27 jours (1 occurrence de chaque)', () => {
		expect.assertions(4);

		const salary = flow({
			cadence: 'monthly',
			direction: 'income',
			lastDate: '2025-01-28',
			anchorDayOfMonth: 28,
			averageAmountCents: 200_000
		});
		const rent = flow({
			cadence: 'monthly',
			direction: 'expense',
			lastDate: '2025-01-03',
			anchorDayOfMonth: 3,
			averageAmountCents: 80_000
		});

		// Horizon volontairement borné à Feb 1 -> Feb 28 (27 jours) : un horizon plus large
		// engloberait aussi la 2e échéance du loyer (03/03), ce que ce test ne couvre pas.
		const result = projectCashFlow({
			confirmedFlows: [salary, rent],
			residualDailyCents: -2_000,
			startingBalanceCents: 50_000,
			fromDate: '2025-02-01',
			horizonDays: 27
		});

		expect(result.days).toHaveLength(28);
		expect(result.days[0]).toEqual({ date: '2025-02-01', balanceCents: 50_000, events: [] });

		const rentDay = result.days.find((day) => day.date === '2025-02-03');
		expect(rentDay?.events.map((e) => e.amountCents)).toEqual([-80_000]);

		// Solde final = 50 000 + 27*(-2000) résiduel + (-80 000 loyer, 03/02) + 200 000 salaire (28/02).
		expect(result.days[result.days.length - 1].balanceCents).toBe(
			50_000 + 27 * -2_000 - 80_000 + 200_000
		);
	});

	it("n'applique ni résiduel ni flux au jour 0 (ancre = solde connu actuel)", () => {
		expect.assertions(1);

		const result = projectCashFlow({
			confirmedFlows: [],
			residualDailyCents: -5_000,
			startingBalanceCents: 12_345,
			fromDate: '2025-06-01',
			horizonDays: 10
		});

		expect(result.days[0].balanceCents).toBe(12_345);
	});

	it("surface une échéance tombant pile sur aujourd'hui dans les events du jour 0, sans l'appliquer au solde", () => {
		expect.assertions(3);

		// Salaire mensuel dont la prochaine échéance calculée tombe exactement sur fromDate
		// (un utilisateur qui consulte son tableau de bord le jour de paie).
		const salary = flow({
			cadence: 'monthly',
			direction: 'income',
			lastDate: '2025-01-01',
			anchorDayOfMonth: 1,
			averageAmountCents: 200_000
		});

		const result = projectCashFlow({
			confirmedFlows: [salary],
			residualDailyCents: 0,
			startingBalanceCents: 10_000,
			fromDate: '2025-02-01',
			horizonDays: 5
		});

		expect(result.days[0].events.map((e) => e.amountCents)).toEqual([200_000]);
		expect(result.days[0].balanceCents).toBe(10_000);
		// L'échéance ne doit pas non plus être ré-appliquée un jour plus tard.
		expect(result.days[1].balanceCents).toBe(10_000);
	});
});

describe('computeResidualDailyCents', () => {
	it('reste robuste à un pic isolé : la semaine contenant le pic est ignorée par la médiane inter-semaines', () => {
		expect.assertions(1);

		// 3 semaines complètes : semaines 1 et 3 régulières (-1000/jour), semaine 2 contient un
		// achat exceptionnel de -50 000 — même protection que l'ancienne médiane journalière.
		const regularWeek = [-1_000, -1_000, -1_000, -1_000, -1_000, -1_000, -1_000];
		const spikeWeek = [-1_000, -1_000, -50_000, -1_000, -1_000, -1_000, -1_000];
		const dailySeries = [...regularWeek, ...spikeWeek, ...regularWeek];

		expect(computeResidualDailyCents(dailySeries)).toBe(-1_000);
	});

	it("capture l'activité éparse (dépense 2 jours sur 7) que la médiane journalière écrasait à 0", () => {
		expect.assertions(1);

		// Profil courant : courses tous les 3-4 jours. Plus de la moitié des jours sont à 0 — une
		// médiane journalière rendrait 0 (biais optimiste corrigé par l'audit de clôture) ; la
		// médiane des sommes hebdomadaires rend -6000/7 = -857.
		const sparseWeek = [-3_000, 0, 0, -3_000, 0, 0, 0];
		const dailySeries = [...sparseWeek, ...sparseWeek, ...sparseWeek];

		expect(computeResidualDailyCents(dailySeries)).toBe(-857);
	});

	it('ignore la semaine partielle en fin de fenêtre (une somme partielle biaiserait la médiane)', () => {
		expect.assertions(1);

		const fullWeek = [-1_000, -1_000, -1_000, -1_000, -1_000, -1_000, -1_000];
		// 3 jours excédentaires massifs : sans troncature ils tireraient la médiane vers le bas.
		const dailySeries = [...fullWeek, ...fullWeek, ...fullWeek, -90_000, -90_000, -90_000];

		expect(computeResidualDailyCents(dailySeries)).toBe(-1_000);
	});

	it("retombe sur la médiane journalière quand la fenêtre fait moins d'une semaine", () => {
		expect.assertions(1);

		expect(computeResidualDailyCents([-2_000, 0, -1_000])).toBe(-1_000);
	});

	it('retourne 0 pour une série vide', () => {
		expect.assertions(1);

		expect(computeResidualDailyCents([])).toBe(0);
	});

	it('interpole la médiane entre les deux semaines centrales pour un nombre pair de semaines complètes, puis arrondit', () => {
		expect.assertions(1);

		// 2 semaines complètes : sommes -700 et -750 -> médiane (nombre pair) = moyenne des deux =
		// -725 -> -725 / 7 = -103,571... -> Math.round -> -104.
		const week1 = [-100, -100, -100, -100, -100, -100, -100]; // somme -700
		const week2 = [-100, -100, -100, -100, -100, -100, -150]; // somme -750
		const dailySeries = [...week1, ...week2];

		expect(computeResidualDailyCents(dailySeries)).toBe(-104);
	});
});

describe('buildDenseDailyNetSeries', () => {
	it('zéro-remplit chaque jour de la fenêtre, y compris ceux sans transaction', () => {
		expect.assertions(1);

		const series = buildDenseDailyNetSeries(
			[
				{ date: '2025-01-01', amountCents: -1_000 },
				{ date: '2025-01-03', amountCents: 500 }
			],
			'2025-01-01',
			'2025-01-05'
		);

		expect(series).toEqual([-1_000, 0, 500, 0]);
	});

	it('cumule plusieurs transactions du même jour', () => {
		expect.assertions(1);

		const series = buildDenseDailyNetSeries(
			[
				{ date: '2025-01-02', amountCents: -400 },
				{ date: '2025-01-02', amountCents: -600 }
			],
			'2025-01-01',
			'2025-01-03'
		);

		expect(series).toEqual([0, -1_000]);
	});

	it('ignore les transactions hors de la fenêtre demandée', () => {
		expect.assertions(1);

		const series = buildDenseDailyNetSeries(
			[
				{ date: '2024-12-31', amountCents: -9_999 },
				{ date: '2025-01-10', amountCents: -9_999 }
			],
			'2025-01-01',
			'2025-01-03'
		);

		expect(series).toEqual([0, 0]);
	});
});

describe('getRemainingDaysInMonthUtc', () => {
	it('compte les jours restants après aujourd’hui, en UTC (28 -> 3 dans un mois de 31 jours)', () => {
		expect.assertions(1);

		expect(getRemainingDaysInMonthUtc(new Date('2025-01-28T23:00:00.000Z'))).toBe(3);
	});

	it('retourne 0 le dernier jour du mois', () => {
		expect.assertions(1);

		expect(getRemainingDaysInMonthUtc(new Date('2025-01-31T05:00:00.000Z'))).toBe(0);
	});

	it('gère février en année bissextile (29 jours en 2028)', () => {
		expect.assertions(1);

		expect(getRemainingDaysInMonthUtc(new Date('2028-02-20T00:00:00.000Z'))).toBe(9);
	});

	it("ignore l'heure locale — seule la date UTC compte", () => {
		expect.assertions(1);

		// 23h59 UTC le 30 : encore le 30 en UTC, peu importe le fuseau du process qui appelle.
		expect(getRemainingDaysInMonthUtc(new Date('2025-04-30T23:59:00.000Z'))).toBe(0);
	});
});

describe('buildRealizedLedgerDays', () => {
	it('reconstruit le solde jour par jour en remontant depuis le solde connu actuel', () => {
		expect.assertions(3);

		const days = buildRealizedLedgerDays(
			[
				{ date: '2025-01-02', amountCents: -1_000 },
				{ date: '2025-01-04', amountCents: 500 }
			],
			10_000,
			'2025-01-05',
			5
		);

		// startEpoch = 2024-12-31, todayEpoch = 2025-01-05 -> 6 jours.
		expect(days).toHaveLength(6);
		expect(days[0]).toEqual({ date: '2024-12-31', balanceCents: 10_500, events: [] });
		expect(days[days.length - 1]).toEqual({ date: '2025-01-05', balanceCents: 10_000, events: [] });
	});

	it('le dernier jour retombe toujours exactement sur endingBalanceCents (ancre), quelles que soient les transactions', () => {
		expect.assertions(1);

		const days = buildRealizedLedgerDays(
			[
				{ date: '2025-01-01', amountCents: 12_345 },
				{ date: '2025-01-03', amountCents: -6_789 }
			],
			42_000,
			'2025-01-05',
			10
		);

		expect(days[days.length - 1].balanceCents).toBe(42_000);
	});

	it('ignore les transactions hors de la fenêtre [today - lookbackDays, today]', () => {
		expect.assertions(1);

		const days = buildRealizedLedgerDays(
			[{ date: '2024-01-01', amountCents: -999_999 }],
			1_000,
			'2025-01-05',
			5
		);

		// Aucune transaction dans la fenêtre -> solde plat à 1000 sur toute la série.
		expect(days.every((day) => day.balanceCents === 1_000)).toBe(true);
	});

	it('ne produit jamais d’événements (réservés à la portion projetée)', () => {
		expect.assertions(1);

		const days = buildRealizedLedgerDays(
			[{ date: '2025-01-03', amountCents: -500 }],
			0,
			'2025-01-05',
			5
		);

		expect(days.every((day) => day.events.length === 0)).toBe(true);
	});
});

describe('detectionEndExclusive', () => {
	it('is midnight UTC of the day after todayIso', () => {
		expect(detectionEndExclusive('2026-07-14').toISOString()).toBe('2026-07-15T00:00:00.000Z');
	});

	it('includes a transaction dated todayIso, at any time of day', () => {
		const bound = detectionEndExclusive('2026-07-14').getTime();
		expect(new Date('2026-07-14T00:00:00.000Z').getTime() < bound).toBe(true);
		expect(new Date('2026-07-14T23:59:59.999Z').getTime() < bound).toBe(true);
	});

	it('excludes a transaction dated the day after todayIso', () => {
		const bound = detectionEndExclusive('2026-07-14').getTime();
		expect(new Date('2026-07-15T00:00:00.000Z').getTime() < bound).toBe(false);
	});

	it('rolls a month/year boundary the same way toEpochDay-based arithmetic elsewhere does', () => {
		expect(detectionEndExclusive('2026-12-31').toISOString()).toBe('2027-01-01T00:00:00.000Z');
	});
});

describe('isReliableConfirmedFlow / hasReliableConfirmedFlow', () => {
	it('rejette un flux confirmé mais de confiance faible — pas assez fiable pour entrer dans le calcul', () => {
		expect.assertions(2);

		const lowConfidenceConfirmed = { status: 'confirmed' as const, confidence: 'low' as const };

		expect(isReliableConfirmedFlow(lowConfidenceConfirmed)).toBe(false);
		expect(hasReliableConfirmedFlow([lowConfidenceConfirmed])).toBe(false);
	});

	it('rejette un flux à confiance élevée mais seulement tentative (pas encore confirmé)', () => {
		expect.assertions(1);

		expect(isReliableConfirmedFlow({ status: 'tentative', confidence: 'high' })).toBe(false);
	});

	it('accepte confirmé + confiance élevée ou moyenne', () => {
		expect.assertions(2);

		expect(isReliableConfirmedFlow({ status: 'confirmed', confidence: 'high' })).toBe(true);
		expect(isReliableConfirmedFlow({ status: 'confirmed', confidence: 'medium' })).toBe(true);
	});

	it('hasReliableConfirmedFlow renvoie true dès qu’un seul flux de la liste est fiable', () => {
		expect.assertions(1);

		expect(
			hasReliableConfirmedFlow([
				{ status: 'tentative', confidence: 'high' },
				{ status: 'confirmed', confidence: 'low' },
				{ status: 'confirmed', confidence: 'medium' }
			])
		).toBe(true);
	});

	describe('flow display tier and amount bounds', () => {
		it('exposes the observed min and max amounts on a detected flow', () => {
			const flows = detectRecurringFlows([
				{
					id: 't1',
					date: '2026-01-05',
					label: 'EDF',
					amountCents: -7400,
					category: 'Énergie',
					type: 'expense'
				},
				{
					id: 't2',
					date: '2026-02-05',
					label: 'EDF',
					amountCents: -7700,
					category: 'Énergie',
					type: 'expense'
				},
				{
					id: 't3',
					date: '2026-03-05',
					label: 'EDF',
					amountCents: -7600,
					category: 'Énergie',
					type: 'expense'
				}
			]);
			expect(flows).toHaveLength(1);
			expect(flows[0].minAmountCents).toBe(7400);
			expect(flows[0].maxAmountCents).toBe(7700);
		});

		it('maps confirmed+high to confirmed, confirmed+medium to likely, everything else to uncertain', () => {
			expect(getFlowDisplayTier({ status: 'confirmed', confidence: 'high' })).toBe('confirmed');
			expect(getFlowDisplayTier({ status: 'confirmed', confidence: 'medium' })).toBe('likely');
			expect(getFlowDisplayTier({ status: 'confirmed', confidence: 'low' })).toBe('uncertain');
			expect(getFlowDisplayTier({ status: 'tentative', confidence: 'high' })).toBe('uncertain');
		});

		it('tier !== uncertain is exactly the existing reliability predicate', () => {
			const statuses = ['confirmed', 'tentative'] as const;
			const confidences = ['low', 'medium', 'high'] as const;
			for (const status of statuses) {
				for (const confidence of confidences) {
					expect(getFlowDisplayTier({ status, confidence }) !== 'uncertain').toBe(
						isReliableConfirmedFlow({ status, confidence })
					);
				}
			}
		});

		it('calls a spread under one euro fixed, and one euro or more variable', () => {
			expect(getFlowAmountVariability({ minAmountCents: 1349, maxAmountCents: 1349 })).toBe(
				'fixed'
			);
			expect(getFlowAmountVariability({ minAmountCents: 1349, maxAmountCents: 1448 })).toBe(
				'fixed'
			);
			expect(getFlowAmountVariability({ minAmountCents: 7400, maxAmountCents: 9600 })).toBe(
				'variable'
			);
		});

		it('treats a spread of exactly 100 cents as variable and 99 cents as fixed', () => {
			expect(getFlowAmountVariability({ minAmountCents: 1000, maxAmountCents: 1099 })).toBe(
				'fixed'
			);
			expect(getFlowAmountVariability({ minAmountCents: 1000, maxAmountCents: 1100 })).toBe(
				'variable'
			);
		});

		it("draws min/max amounts from the flow's own amount cluster, not the whole label group", () => {
			const flows = detectRecurringFlows([
				tx({ date: '2026-01-05', label: 'Amazon', amountCents: -999, category: 'Shopping' }),
				tx({ date: '2026-02-05', label: 'Amazon', amountCents: -1010, category: 'Shopping' }),
				tx({ date: '2026-03-05', label: 'Amazon', amountCents: -990, category: 'Shopping' }),
				tx({ date: '2026-01-20', label: 'Amazon', amountCents: -12000, category: 'Shopping' }),
				tx({ date: '2026-02-20', label: 'Amazon', amountCents: -12100, category: 'Shopping' }),
				tx({ date: '2026-03-20', label: 'Amazon', amountCents: -11900, category: 'Shopping' })
			]);

			expect(flows).toHaveLength(2);

			const smallFlow = flows.find((flow) => flow.maxAmountCents < 5000);
			const largeFlow = flows.find((flow) => flow.maxAmountCents >= 5000);
			expect(smallFlow).toBeDefined();
			expect(largeFlow).toBeDefined();

			expect(smallFlow?.minAmountCents).toBe(990);
			expect(smallFlow?.maxAmountCents).toBe(1010);

			expect(largeFlow?.minAmountCents).toBe(11900);
			expect(largeFlow?.maxAmountCents).toBe(12100);
		});
	});
});
