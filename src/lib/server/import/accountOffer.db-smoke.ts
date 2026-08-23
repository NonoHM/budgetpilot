import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildAccountOffer } from './accountOffer';
import type { ParsedCsvRow } from './types';

/**
 * Against a real engine because the two things that can be wrong here are both the database's
 * answer: which rows the `where` returns, and what `_count` counts. A fake decides both.
 */
const ROWS: ParsedCsvRow[] = [
	{ cells: ['date', 'libelle', 'montant'], line: 1 },
	{ cells: ['2026-06-01', 'Mercerie', '-45.20'], line: 2 }
];

let mine = '';

beforeEach(async () => {
	const u = await prisma.user.create({
		data: {
			email: `offer-${Date.now()}-${Math.round(performance.now() * 1000)}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	mine = u.id;
});

function makeAccount(name: string, source: string, extra: Record<string, unknown> = {}) {
	return prisma.account.create({
		data: { userId: mine, name, source, currency: 'EUR', exponent: 2, ...extra },
		select: { id: true }
	});
}

describe('the account offer the designation screen is given', () => {
	it('offers a statement account and counts its transactions', async () => {
		// SEPARATES: « the second line carries the real count » FROM « it carries a zero or a
		// placeholder ». The count is the half of the option that tells two accounts at one bank
		// apart, so a wrong one is not cosmetic.
		expect.assertions(3);
		const account = await makeAccount('BP · Compte courant', 'banque_populaire', {
			discriminant: '4417'
		});
		const category = await prisma.category.create({
			data: { userId: mine, name: 'Non catégorisé', nameKey: 'non-categorise' },
			select: { id: true }
		});
		await prisma.transaction.create({
			data: {
				userId: mine,
				accountId: account.id,
				categoryId: category.id,
				date: new Date('2026-06-01T00:00:00.000Z'),
				label: 'Mercerie',
				amountCents: -4520,
				type: 'expense',
				currency: 'EUR',
				exponent: 2,
				source: 'csv'
			}
		});
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.options).toHaveLength(1);
		expect(offer.options[0].transactionCount).toBe(1);
		expect(offer.options[0].discriminant).toBe('4417');
	});

	it('excludes a MANUAL bucket, which is not a place a statement comes from', async () => {
		// SEPARATES: « the offer is destinations only » FROM « the offer is every account ». Offering
		// the manual bucket would let a statement be filed into the one account whose rows the user
		// typed themselves, which is the mixture the whole model exists to prevent.
		expect.assertions(2);
		await makeAccount('Saisie manuelle', 'manual');
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.options).toHaveLength(0);
		expect(await prisma.account.count({ where: { userId: mine } })).toBe(1);
	});

	it('excludes an ARCHIVED account, and does so in the query', async () => {
		// SEPARATES: « archived is filtered before the count » FROM « archived is filtered on the
		// screen ». The second leaves the count and the list disagreeing, and the plate keeps an
		// archived account off the panel rather than greying it.
		expect.assertions(1);
		await makeAccount('Vieux BP', 'banque_populaire', {
			archivedAt: new Date('2026-01-01T00:00:00.000Z')
		});
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.options).toHaveLength(0);
	});

	it('answers rank 3 with no candidates for a shape it has never seen', async () => {
		// The calibration the exclusions above need: without it, an empty offer is equally explained
		// by a resolver that never answers. SEPARATES « resolution ran and found nothing remembered »
		// FROM « resolution did not run ».
		expect.assertions(2);
		await makeAccount('BP · Compte courant', 'banque_populaire');
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.resolution).toStrictEqual({ rank: 3, candidates: [] });
		expect(offer.options).toHaveLength(1);
	});
});
