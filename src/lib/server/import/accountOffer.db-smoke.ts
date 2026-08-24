import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { GENERIC_BUCKET_STORED_NAME } from '$lib/domain/account';
import * as m from '$lib/paraglide/messages';
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

	it('offers the generic bucket under its DISPLAYED name, not its stored one', async () => {
		// SEPARATES: « the option carries `displayAccountName(account)` » FROM « it carries
		// `account.name` », which is the raw column.
		//
		// Found by a SCREENSHOT rather than by any of this file's siblings. The designation screen
		// showed « Compte import CSV » on an English page: the bucket's stored name is a lookup key,
		// half of `@@unique([userId, name, source])`, and it is a French literal because it always
		// was one. Every other surface in the product already substitutes it, so this panel was the
		// one screen showing a storage key, on the feature whose whole subject is that name.
		//
		// `nameKey` is deliberately NULL here, which is the field case: the column is nullable, the
		// boot backfill writes it only for accounts with an institution, and the generic bucket has
		// none. `isGenericallyNamed` recomputes the key from the name for exactly this row, so a
		// fixture that pre-filled `nameKey` would pass while the real row failed.
		expect.assertions(3);
		await makeAccount(GENERIC_BUCKET_STORED_NAME, 'csv');
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.options).toHaveLength(1);
		expect(offer.options[0].name).toBe(m.accounts_generic_bucket());
		// The companion, because the assertion above would also pass if the substitution replaced
		// every name with a constant: the stored key must not be what reaches the screen.
		expect(offer.options[0].name).not.toBe(GENERIC_BUCKET_STORED_NAME);
	});

	it('leaves a name the USER chose exactly as they wrote it', async () => {
		// The other half, and it is what stops the fix above becoming a blanket rewrite. SEPARATES
		// « only the machine's own name is substituted » FROM « every name is passed through a
		// renderer », which would quietly change what a user typed.
		expect.assertions(2);
		await makeAccount('Compte courant', 'csv');
		const offer = await buildAccountOffer({ userId: mine, rows: ROWS });
		expect(offer.options).toHaveLength(1);
		expect(offer.options[0].name).toBe('Compte courant');
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
