import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { decideAutoAccount } from './autoAccount';
import { headersOf, sourceFingerprintFor } from './sourceSignature';
import type { ParsedCsvRow } from './types';

/**
 * WHICH ACCOUNT AN AUTO-DETECTED STATEMENT LANDS IN, against a real engine.
 *
 * `/import` imports a recognised file without ever opening the designation screen, so this decision
 * is made with nothing on screen. Until #476 it was made from the account's `source` alone: two
 * accounts of one source refused, and the refusal named a screen that path cannot reach.
 *
 * Against a real engine rather than the route's fake, for the reason `resolveBySource.db-smoke.ts`
 * gives: a hand-written mock decides what `findMany` returns, so « the file's own account column
 * chose the right row » and « the fake had one row to return » are the same green.
 */

let mine = '';
let other = '';

beforeEach(async () => {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const a = await prisma.user.create({
		data: { email: `auto-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const b = await prisma.user.create({
		data: { email: `auto-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	mine = a.id;
	other = b.id;
});

function makeAccount(
	userId: string,
	name: string,
	source: string,
	discriminant: string | null = null,
	archived = false
) {
	return prisma.account.create({
		data: {
			userId,
			name,
			source,
			currency: 'EUR',
			exponent: 2,
			discriminant,
			archivedAt: archived ? new Date('2026-01-01T00:00:00.000Z') : null
		},
		select: { id: true }
	});
}

/**
 * A statement whose account column is CONSTANT and well formed, which is the shape
 * `findDiscriminantColumn` calls rank 1 certain. `identifier` is the whole column value; the
 * fragment is its last four characters.
 */
function statement(identifier: string): ParsedCsvRow[] {
	return [
		{ cells: ['Date', 'Libelle', 'Montant', 'Compte'], line: 1 },
		{ cells: ['01/08/2026', 'CARREFOUR', '-12,00', identifier], line: 2 },
		{ cells: ['02/08/2026', 'SNCF', '-40,00', identifier], line: 3 }
	];
}

/** The same statement with no account column at all: the file offers no evidence either way. */
const SILENT: ParsedCsvRow[] = [
	{ cells: ['Date', 'Libelle', 'Montant'], line: 1 },
	{ cells: ['01/08/2026', 'CARREFOUR', '-12,00'], line: 2 }
];

describe('the auto path’s destination, now that the file is read too', () => {
	it('leaves one account of that source exactly as it was', async () => {
		// SEPARATES: « the ambiguity work changed only the ambiguous case » FROM « it now asks, or
		// resolves differently, on the path every install today takes ». This is the loss direction:
		// the change makes the app refuse less, so what can break is a file that imports today.
		expect.assertions(3);
		const only = await makeAccount(mine, 'Banque Populaire', 'banque_populaire');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: statement('12344417')
		});
		expect(decision.kind).toBe('by-source');
		// Positively: `by-source` means the caller runs the untouched resolve-or-create path, so
		// nothing here may have decided an account behind it. `existing` is not that decision, and
		// asserting it is the one account of the source is what separates « carried for the
		// collision fingerprints » from « quietly chosen ».
		expect('bucket' in decision).toBe(false);
		expect(decision.kind === 'by-source' && decision.existing?.accountId).toBe(only.id);
	});

	it('lets the file name the account when two share the source', async () => {
		// SEPARATES: « the file's own account column decides » FROM « two accounts of one source is
		// a dead end whatever the file says ». This is #476's reframing: rank 1 certainty was
		// available and unasked, on the exact configuration #480 shipped `discriminant` to resolve.
		expect.assertions(2);
		// The named account is created SECOND, and that is the fixture doing work rather than
		// reading well. `findImportBucketAccountBySource` orders by `createdAt` then `id`, so with
		// the named account first this test would pass identically against « take the first
		// candidate », which is the exact failure the rank is supposed to prevent.
		await makeAccount(mine, 'BP Livret A', 'banque_populaire', '9032');
		const courant = await makeAccount(mine, 'BP Compte courant', 'banque_populaire', '4417');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: statement('12344417')
		});
		expect(decision.kind).toBe('account');
		expect(decision.kind === 'account' && decision.bucket.accountId).toBe(courant.id);
	});

	it('asks when two share the source and the file says nothing', async () => {
		// SEPARATES: « the question is handed back WITH the accounts to answer it » FROM « the first
		// row wins » and from « the refusal carries nothing and the path dead-ends ». The options
		// are asserted, not merely the kind: an `ask` with an empty list is the dead end again.
		expect.assertions(3);
		const courant = await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		const livret = await makeAccount(mine, 'BP Livret A', 'banque_populaire');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: SILENT
		});
		expect(decision.kind).toBe('ask');
		const ids = decision.kind === 'ask' ? decision.offer.options.map((o) => o.id) : [];
		expect(ids).toContain(courant.id);
		expect(ids).toContain(livret.id);
	});

	it('does not let a memory decide on a path that shows the user nothing', async () => {
		// SEPARATES: « only the file's own account column short-circuits » FROM « anything the
		// resolver answers with an account short-circuits ». A rank 3 answer is a memory written by
		// the designation screen, where it PRE-FILLS a control the user can see and change. There is
		// no control here, so a memory deciding would replay a memorised mistake unattended, which is
		// what `sourceSignature.ts` refuses under « THE FILE BEATS THE MEMORY, ALWAYS ». Without this
		// the rule lives only in a docstring, and a docstring is not a check.
		expect.assertions(3);
		const courant = await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		await makeAccount(mine, 'BP Livret A', 'banque_populaire');
		await prisma.importSourceSignature.create({
			data: {
				userId: mine,
				fingerprint: sourceFingerprintFor(headersOf(SILENT)),
				discriminant: null,
				accountId: courant.id,
				useCount: 3,
				lastUsedAt: new Date('2026-08-01T00:00:00.000Z')
			}
		});
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: SILENT
		});
		// The memory WAS found, so this separates « read and declined » from « never looked up »,
		// which would pass the line below for the wrong reason.
		expect(decision.kind === 'ask' && decision.offer.memory?.useCount).toBe(3);
		expect(decision.kind).toBe('ask');
		expect(decision.kind === 'account' && decision.bucket.accountId).not.toBe(courant.id);
	});

	it('refuses a fragment held by an account of a DIFFERENT source', async () => {
		// SEPARATES: « rank 1 is checked against the accounts of THIS file's source » FROM « any
		// account holding those four characters wins ». `assertDiscriminantFree` makes a fragment
		// unique across the user's accounts and says nothing about their source, so without the
		// check a Banque Populaire statement lands in a Revolut account on a coincidence, silently
		// and with full confidence. That is worse than the dead end this change removes.
		expect.assertions(2);
		await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		await makeAccount(mine, 'BP Livret A', 'banque_populaire');
		const revolut = await makeAccount(mine, 'Revolut', 'revolut', '4417');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: statement('12344417')
		});
		expect(decision.kind).toBe('ask');
		expect(decision.kind === 'account' && decision.bucket.accountId).not.toBe(revolut.id);
	});

	it('honours the account the user answered with', async () => {
		// SEPARATES: « the posted answer decides the destination » FROM « the answer is read and the
		// source lookup still refuses ». Without this the control renders, the user chooses, and the
		// same refusal comes back: a dead end with a button on it.
		expect.assertions(2);
		await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		const livret = await makeAccount(mine, 'BP Livret A', 'banque_populaire');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: SILENT,
			chosenId: livret.id
		});
		expect(decision.kind).toBe('account');
		expect(decision.kind === 'account' && decision.bucket.accountId).toBe(livret.id);
	});

	it('treats an account reference as a claim, not a fact', async () => {
		// SEPARATES: « the posted id is resolved against THIS user's accounts » FROM « it is trusted
		// because it arrived in a form ». ASVS 5.0 V8.1.1. Only a real engine holds the other user's
		// row, which is why this assertion cannot be written against the route's fake.
		expect.assertions(2);
		await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		await makeAccount(mine, 'BP Livret A', 'banque_populaire');
		const theirs = await makeAccount(other, 'Leur BP', 'banque_populaire');
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: SILENT,
			chosenId: theirs.id
		});
		expect(decision.kind).toBe('refused');
		expect(decision.kind === 'refused' && decision.reason).toBe('not-found');
	});

	it('refuses an archived account differently, so the user knows what to do', async () => {
		// SEPARATES: « archived is answered as archived » FROM « archived is answered as not-found ».
		// Not-yours and not-found are one answer because the asker may not be the owner; this one
		// they own, and only the archived sentence tells them what to do next.
		expect.assertions(2);
		await makeAccount(mine, 'BP Compte courant', 'banque_populaire');
		const old = await makeAccount(mine, 'Vieux BP', 'banque_populaire', null, true);
		const decision = await decideAutoAccount({
			userId: mine,
			source: 'banque_populaire',
			rows: SILENT,
			chosenId: old.id
		});
		expect(decision.kind).toBe('refused');
		expect(decision.kind === 'refused' && decision.reason).toBe('archived');
	});
});
