import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { fingerprintFor } from './fingerprint';
import type { ColumnMappingInput } from './model';
import {
	COLUMN_MAPPINGS_PER_USER_ENV,
	countColumnMappings,
	readColumnMapping,
	recordColumnMappingUse,
	saveColumnMapping
} from './store';

const HEADERS = ['date operation', 'libelle complet', 'montant', 'categorie banque'];

const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'date operation',
	labelColumn: 'libelle complet',
	amountColumn: 'montant',
	categoryColumn: 'categorie banque',
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 4
};

let alice = '';
let bob = '';

beforeAll(async () => {
	const stamp = Date.now();
	const [a, b] = await Promise.all([
		prisma.user.create({
			data: { email: `mapping-a-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		}),
		prisma.user.create({
			data: { email: `mapping-b-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		})
	]);
	alice = a.id;
	bob = b.id;
});

afterEach(() => {
	delete process.env[COLUMN_MAPPINGS_PER_USER_ENV];
});

describe('a mapping is per user, and the fingerprint is shared by construction', () => {
	it("does not return another user's mapping for the same header shape", async () => {
		// The fingerprint is derived from a bank's PUBLIC column names, so two users of the same
		// bank share one BY DESIGN. This is not a collision test.
		const fingerprint = fingerprintFor(HEADERS, 'name');
		const saved = await saveColumnMapping(alice, fingerprint, MAPPING);
		expect(saved.ok).toBe(true);

		expect(await readColumnMapping(bob, HEADERS)).toBeNull();
		// The presence half. Without it, a reader that always returns null passes perfectly.
		expect(await readColumnMapping(alice, HEADERS)).not.toBeNull();
	});

	it('lets both users hold their own mapping for the same shape', async () => {
		const fingerprint = fingerprintFor(HEADERS, 'name');
		expect((await saveColumnMapping(bob, fingerprint, MAPPING)).ok).toBe(true);

		const forAlice = await readColumnMapping(alice, HEADERS);
		const forBob = await readColumnMapping(bob, HEADERS);
		expect(forAlice?.userId).toBe(alice);
		expect(forBob?.userId).toBe(bob);
		expect(forAlice?.id).not.toBe(forBob?.id);
	});
});

describe('the lookup finds either canonical form', () => {
	it('finds a position-matched mapping, whose fingerprint is ordered rather than sorted', async () => {
		const headers = ['', 'c1', 'c2', 'c3'];
		const fingerprint = fingerprintFor(headers, 'position');
		const positional: ColumnMappingInput = {
			matchBy: 'position',
			dateColumn: null,
			labelColumn: null,
			amountColumn: null,
			categoryColumn: null,
			dateIndex: 0,
			labelIndex: 1,
			amountIndex: 2,
			categoryIndex: null,
			columnCount: 4
		};
		expect((await saveColumnMapping(alice, fingerprint, positional)).ok).toBe(true);

		const found = await readColumnMapping(alice, headers);
		expect(found?.matchBy).toBe('position');

		// And the reordered file does NOT find it, which is the whole reason that space is ordered.
		// Under a sorted fingerprint this would match, and the stored indices would then point at
		// different columns: amounts read out of the date column on a file that looks fine.
		expect(await readColumnMapping(alice, ['c3', 'c2', 'c1', ''])).toBeNull();
	});
});

describe('the validator runs on the write path, not only in the UI', () => {
	it('refuses a mapping whose category repeats a required role', async () => {
		const result = await saveColumnMapping(alice, fingerprintFor(['x', 'y'], 'name'), {
			...MAPPING,
			categoryColumn: MAPPING.labelColumn
		});
		expect(result).toEqual({
			ok: false,
			reason: { code: 'category-repeats-required-role', role: 'label' }
		});
	});

	it('bounds a column name the file made arbitrarily long', async () => {
		const long = 'x'.repeat(500);
		const fingerprint = fingerprintFor(['long'], 'name');
		expect(
			(await saveColumnMapping(alice, fingerprint, { ...MAPPING, labelColumn: long })).ok
		).toBe(true);

		const stored = await prisma.columnMapping.findUnique({
			where: { userId_fingerprint: { userId: alice, fingerprint } },
			select: { labelColumn: true }
		});
		// The bound is what makes this write succeed on MySQL, where the column is varchar(191).
		expect(stored?.labelColumn).toHaveLength(120);
	});
});

describe('the cap', () => {
	it('refuses a new mapping past it, and does not evict anything', async () => {
		const first = fingerprintFor(['cap-first'], 'name');
		expect((await saveColumnMapping(bob, first, MAPPING)).ok).toBe(true);

		process.env[COLUMN_MAPPINGS_PER_USER_ENV] = String(await countColumnMappings(bob));
		const refused = await saveColumnMapping(bob, fingerprintFor(['cap-second'], 'name'), MAPPING);

		expect(refused.ok).toBe(false);
		expect(refused).toMatchObject({ reason: { code: 'cap-reached' } });
		// Refused, not evicted: the mapping that was already there is still there.
		expect(await readColumnMapping(bob, ['cap-first'])).not.toBeNull();
	});

	it('still lets an EXISTING mapping be corrected at the cap', async () => {
		// The half that can actually fail. A cap counted without the exists check would make
		// correcting a designation impossible at exactly the moment the user most needs to.
		const fingerprint = fingerprintFor(['cap-first'], 'name');
		process.env[COLUMN_MAPPINGS_PER_USER_ENV] = String(await countColumnMappings(bob));

		const corrected = await saveColumnMapping(bob, fingerprint, {
			...MAPPING,
			categoryColumn: null
		});

		expect(corrected.ok).toBe(true);
		const stored = await readColumnMapping(bob, ['cap-first']);
		expect(stored?.categoryColumn).toBeNull();
	});
});

describe('use counting, which is what the recap sentence reports', () => {
	it('increments and stamps, scoped to the owner', async () => {
		const fingerprint = fingerprintFor(['counted'], 'name');
		const saved = await saveColumnMapping(alice, fingerprint, MAPPING);
		expect(saved.ok).toBe(true);
		const id = saved.ok ? saved.id : '';

		await recordColumnMappingUse(alice, id);
		await recordColumnMappingUse(alice, id);
		// Another user naming the same row must not move it.
		await recordColumnMappingUse(bob, id);

		const stored = await prisma.columnMapping.findUnique({ where: { id } });
		expect(stored?.useCount).toBe(2);
		expect(stored?.lastUsedAt).not.toBeNull();
	});
});

describe('the cascade, which is where engines have diverged before', () => {
	it('deletes a user mappings and nothing else refuses the delete', async () => {
		// This repository has measured a cascade ORDER diverging between engines where the schema
		// did not (a RESTRICT on one path made deleting a user fail on PostgreSQL only). This model
		// has one parent and no children, so the delete should be unremarkable on all three, and
		// asserting it is how "should be" becomes "is".
		const stamp = Date.now();
		const doomed = await prisma.user.create({
			data: { email: `mapping-doomed-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		});
		expect(
			(await saveColumnMapping(doomed.id, fingerprintFor(['doomed'], 'name'), MAPPING)).ok
		).toBe(true);
		expect(await countColumnMappings(doomed.id)).toBe(1);

		await prisma.user.delete({ where: { id: doomed.id } });

		expect(await countColumnMappings(doomed.id)).toBe(0);
		// And the other users' mappings are untouched, which is the presence half.
		expect(await countColumnMappings(alice)).toBeGreaterThan(0);
	});
});
