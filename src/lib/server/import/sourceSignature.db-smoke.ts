import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import {
	rememberStatementAccount,
	resolveStatementAccount,
	sourceFingerprintFor,
	type ResolvableAccount
} from './sourceSignature';
import type { ParsedCsvRow } from './types';

/**
 * The source signature against a real engine, for the three things a fake cannot answer.
 *
 * **The scoping.** A unit spec's fake decides what `findMany` returns, so dropping `userId` from
 * the where clause leaves it green. Measured on this branch: break B7 reddened the one unit test
 * that reads the query's arguments and left the other eight passing. Only two real users holding
 * the identical fingerprint can tell the difference.
 *
 * **`@@unique([userId, fingerprint, discriminant])` under a NULL.** NULL never equals NULL in a
 * unique index on any of the three engines, which is half of why the write is not an upsert.
 *
 * **The cascade.** Deleting an account removes its signatures through the foreign key, which no
 * code here performs and no mock can prove.
 */

/** A file of a given shape, carrying nothing that can name an account: rank 3 territory. */
function rowsFrom(headers: string[]): ParsedCsvRow[] {
	return [
		{ cells: headers, line: 1 },
		{ cells: ['2026-08-01', 'Cafe Fictif', '-2,50', 'Compte courant'], line: 2 },
		{ cells: ['2026-08-02', 'Boulangerie Fictive', '-3,10', 'Compte courant'], line: 3 }
	];
}

const stamp = Date.now();
const headersFor = (label: string) => ['date', 'libelle', 'montant', `compte-${label}-${stamp}`];

let mine = '';
let other = '';
let myAccount: ResolvableAccount = { id: '', source: 'csv', archivedAt: null, discriminant: null };
let otherAccount: ResolvableAccount = {
	id: '',
	source: 'csv',
	archivedAt: null,
	discriminant: null
};

async function makeAccount(userId: string, name: string, discriminant: string | null) {
	return prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name,
			nameKey: computeNameKey(name),
			// NOT the default of `manual`, which `isStatementAccount` excludes: a manual bucket is
			// not a destination, so a fixture left on the default would test nothing.
			source: 'csv',
			discriminant
		},
		select: { id: true, source: true, archivedAt: true, discriminant: true }
	});
}

beforeAll(async () => {
	const [a, b] = await Promise.all([
		prisma.user.create({
			data: { email: `signature-mine-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		}),
		prisma.user.create({
			data: { email: `signature-other-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		})
	]);
	mine = a.id;
	other = b.id;
	myAccount = await makeAccount(mine, `Compte courant ${stamp}`, '0185');
	otherAccount = await makeAccount(other, `Compte voisin ${stamp}`, '0185');
});

describe('the source signature is read scoped to its owner', () => {
	/**
	 * ASVS 5.0 V8.2.2, and `ColumnMapping`'s argument transfers verbatim.
	 *
	 * A fingerprint is a hash of a bank's PUBLIC column names, so every user of that bank shares
	 * one. A global lookup is the DESIGNED behaviour of this key, not a rare collision to guard
	 * against. Here the two users have the identical fingerprint by construction, because they
	 * uploaded the same bank's export.
	 *
	 * The observable difference the break produces: unscoped, my resolution finds a row pointing at
	 * an account that is not mine, and answers `orphan` ("the account you used is gone") instead of
	 * `candidates: []` ("this shape is new to us"). Both are refusals, and they are not the same
	 * sentence, which is why the two answers are kept apart in `resolveStatementAccount`.
	 */
	it('never reads a signature belonging to another user', async () => {
		const headers = headersFor('alone');
		const fingerprint = sourceFingerprintFor(headers);

		expect(
			await rememberStatementAccount({
				userId: other,
				fingerprint,
				discriminant: null,
				accountId: otherAccount.id
			})
		).toBe('remembered');

		// CALIBRATION BESIDE THE EMPTINESS: the other user's row really is there to be found, and
		// mine really is not. Without both figures a reader cannot tell a scoped read from a
		// lookup that returned nothing because nothing was written.
		expect(await prisma.importSourceSignature.count({ where: { fingerprint } })).toBe(1);
		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			0
		);

		const resolution = await resolveStatementAccount({
			userId: mine,
			rows: rowsFrom(headers),
			accounts: [myAccount]
		});

		expect(resolution).toStrictEqual({ rank: 3, candidates: [] });
	});

	it('lets both users hold their own signature for the identical fingerprint', async () => {
		const headers = headersFor('shared');
		const fingerprint = sourceFingerprintFor(headers);

		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: null,
			accountId: myAccount.id
		});
		await rememberStatementAccount({
			userId: other,
			fingerprint,
			discriminant: null,
			accountId: otherAccount.id
		});

		// Two rows under one fingerprint, which is the shape the composite unique exists to permit.
		expect(await prisma.importSourceSignature.count({ where: { fingerprint } })).toBe(2);

		const forMine = await resolveStatementAccount({
			userId: mine,
			rows: rowsFrom(headers),
			accounts: [myAccount]
		});
		const forOther = await resolveStatementAccount({
			userId: other,
			rows: rowsFrom(headers),
			accounts: [otherAccount]
		});

		expect(forMine).toStrictEqual({ rank: 3, candidates: [myAccount.id] });
		expect(forOther).toStrictEqual({ rank: 3, candidates: [otherAccount.id] });
	});
});

describe('the source signature write happens at a successful import and nowhere else', () => {
	/**
	 * "A cancelled run writes nothing", stated as the property that can actually fail.
	 *
	 * Every preview calls `resolveStatementAccount`, including every preview the user abandons.
	 * A read that wrote what it had just guessed would memorise a destination nobody ever
	 * confirmed, and the next import of that shape would arrive pre-answered by a run that was
	 * cancelled. The absolute figure is 0, with the calibration that the confirmed path writes
	 * exactly 1 through the same fingerprint.
	 */
	it('writes nothing when the file is only read, and exactly one row when it is confirmed', async () => {
		const headers = headersFor('cancelled');
		const fingerprint = sourceFingerprintFor(headers);

		await resolveStatementAccount({
			userId: mine,
			rows: rowsFrom(headers),
			accounts: [myAccount]
		});
		await resolveStatementAccount({
			userId: mine,
			rows: rowsFrom(headers),
			accounts: [myAccount]
		});

		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			0
		);

		// The calibration: the same fingerprint, confirmed, writes one row. Without it a zero above
		// is equally consistent with a table nothing can write to.
		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: null,
			accountId: myAccount.id
		});
		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			1
		);
	});

	it('increments useCount and stamps lastUsedAt on the second import, without adding a row', async () => {
		const headers = headersFor('counted');
		const fingerprint = sourceFingerprintFor(headers);

		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: null,
			accountId: myAccount.id
		});
		const first = await prisma.importSourceSignature.findFirst({
			where: { userId: mine, fingerprint },
			select: { id: true, useCount: true, lastUsedAt: true }
		});
		expect(first?.useCount).toBe(1);
		expect(first?.lastUsedAt).not.toBeNull();

		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: null,
			accountId: myAccount.id
		});

		// ONE row, not two. A NULL discriminant is what makes this worth asserting against a real
		// engine: NULL never equals NULL in a unique index, so an upsert keyed on the composite
		// would have inserted a second row here on all three engines.
		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			1
		);
		const second = await prisma.importSourceSignature.findFirst({
			where: { userId: mine, fingerprint },
			select: { id: true, useCount: true }
		});
		expect(second?.id).toBe(first?.id);
		expect(second?.useCount).toBe(2);
	});

	/**
	 * ASVS 5.0 V8.1.1: the account id reaches this write from a screen, so it is a claim.
	 *
	 * The foreign key refuses an account that does not EXIST and says nothing about who owns one,
	 * so this is the only thing standing between a posted id and a signature row pointing at
	 * somebody else's account. Not-yours and not-found are one answer.
	 */
	it("refuses to remember another user's account, and says only not-found", async () => {
		const headers = headersFor('foreign');
		const fingerprint = sourceFingerprintFor(headers);

		expect(
			await rememberStatementAccount({
				userId: mine,
				fingerprint,
				discriminant: null,
				accountId: otherAccount.id
			})
		).toBe('not-found');
		// An id that never existed is reported IDENTICALLY, so the answer is not an oracle for
		// whether somebody else's id is real.
		expect(
			await rememberStatementAccount({
				userId: mine,
				fingerprint,
				discriminant: null,
				accountId: 'ckzzzzzzzzzzzzzzzzzzzzzzz'
			})
		).toBe('not-found');

		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			0
		);
		// The presence half: this fingerprint IS writeable, by its owner.
		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: null,
			accountId: myAccount.id
		});
		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			1
		);
	});
});

describe('the source signature ambiguity is a real row shape, not a contrived one', () => {
	it('holds two accounts under one fingerprint and returns both, pre-filling neither', async () => {
		const headers = headersFor('ambiguous');
		const fingerprint = sourceFingerprintFor(headers);
		const savings = await makeAccount(mine, `Livret ${stamp}`, '9032');

		// Two accounts at one bank: one shape, two discriminants, which is exactly what the
		// composite unique permits and what makes the ambiguity ordinary rather than exotic.
		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: '0185',
			accountId: myAccount.id
		});
		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: '9032',
			accountId: savings.id
		});
		expect(await prisma.importSourceSignature.count({ where: { userId: mine, fingerprint } })).toBe(
			2
		);

		// The file carries no account column, so nothing can tell the two apart.
		const resolution = await resolveStatementAccount({
			userId: mine,
			rows: rowsFrom(headers),
			accounts: [myAccount, savings]
		});

		expect('accountId' in resolution).toBe(false);
		expect(resolution.rank).toBe(3);
		// Sorted rather than positional: two rows written in the same millisecond can tie on
		// `createdAt`, and this assertion is about the SET rather than about the tie break.
		expect('candidates' in resolution ? [...resolution.candidates].sort() : []).toStrictEqual(
			[myAccount.id, savings.id].sort()
		);
	});
});

describe('the source signature cascade, which the foreign key performs and no code here does', () => {
	it('removes an account signatures when the account goes, and leaves the others', async () => {
		const headers = headersFor('cascade');
		const fingerprint = sourceFingerprintFor(headers);
		const doomed = await makeAccount(mine, `Compte supprime ${stamp}`, '4417');

		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: '4417',
			accountId: doomed.id
		});
		await rememberStatementAccount({
			userId: mine,
			fingerprint,
			discriminant: '0185',
			accountId: myAccount.id
		});
		expect(await prisma.importSourceSignature.count({ where: { accountId: doomed.id } })).toBe(1);

		await prisma.account.delete({ where: { id: doomed.id } });

		expect(await prisma.importSourceSignature.count({ where: { accountId: doomed.id } })).toBe(0);
		// The presence half: the sibling signature under the same fingerprint is untouched.
		expect(
			await prisma.importSourceSignature.count({
				where: { accountId: myAccount.id, fingerprint }
			})
		).toBe(1);
	});
});
