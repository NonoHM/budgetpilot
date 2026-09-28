import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import {
	accountMemoryKeyFor,
	accountMemoryKeyWith,
	deriveAccountMemoryKey
} from './accountMemoryKey';
import { accountMemoryKeyOf } from './accountMemory';
import { findDiscriminantColumn, statementIdentifier } from './discriminant';
import type { ParsedCsvRow } from './types';

/**
 * The key a remembered account is stored under (#599's re-ruling): a keyed hash of the FULL
 * identifier, under a key DERIVED from the server secret for this purpose alone.
 *
 * Each case names the two states it separates. No expected digest is typed here: a copied value
 * would assert the copy, so every expectation is built by calling the production functions.
 */

const SECRET = 'ab'.repeat(32);
const ROTATED = 'cd'.repeat(32);
const saved = env.RATE_LIMIT_HASH_SECRET;

afterEach(() => {
	env.RATE_LIMIT_HASH_SECRET = saved;
});

function statement(identifier: string): ParsedCsvRow[] {
	return [
		{ cells: ['date', 'libelle', 'montant', 'compte'], line: 1 },
		{ cells: ['2026-08-01', 'CARTE', '-3,10', identifier], line: 2 },
		{ cells: ['2026-08-02', 'VIREMENT', '12,00', identifier], line: 3 }
	];
}

describe('the memory key', () => {
	it('is 64 lowercase hex characters, the same for the same identifier', () => {
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const key = accountMemoryKeyFor('FR7630001007941234567890185');
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(accountMemoryKeyFor('FR7630001007941234567890185')).toBe(key);
	});

	it('differs for two identifiers that share their last four characters', () => {
		// SEPARATES « keyed on the full identifier » FROM « keyed on the fragment », which would put
		// two cards of one bank ending in the same digits under one answer.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		expect(accountMemoryKeyFor('11110185')).not.toBe(accountMemoryKeyFor('22220185'));
	});

	it('is not the rate limiter’s own HMAC of the same value', () => {
		// SEPARATES « a purpose-bound DERIVED key » FROM « the raw secret reused as this key », which
		// would make this table's digests comparable with the limiter's for any shared input.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const raw = createHmac('sha256', SECRET).update('11110185').digest('hex');
		const rawBytes = accountMemoryKeyWith(Buffer.from(SECRET, 'hex'), '11110185');
		expect(accountMemoryKeyFor('11110185')).not.toBe(raw);
		expect(accountMemoryKeyFor('11110185')).not.toBe(rawBytes);
	});

	it('is the derived key applied to the identifier, under the configured secret', () => {
		// Ties the environment path to the pure one, so the cases above speak about what ships.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		expect(accountMemoryKeyFor('11110185')).toBe(
			accountMemoryKeyWith(deriveAccountMemoryKey(SECRET), '11110185')
		);
	});

	it('changes when the secret is rotated, which is what makes the app ask again', () => {
		// The documented consequence of a rotation, asserted rather than claimed.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const before = accountMemoryKeyFor('11110185');
		env.RATE_LIMIT_HASH_SECRET = ROTATED;
		expect(accountMemoryKeyFor('11110185')).not.toBe(before);
	});

	it('refuses to key anything without a well-formed secret', () => {
		env.RATE_LIMIT_HASH_SECRET = 'short';
		expect(() => accountMemoryKeyFor('11110185')).toThrow(/64 hex characters/);
	});
});

describe('what the key is taken over', () => {
	it('is the FULL canonical identifier: grouped and run-together spellings are one key', () => {
		// SEPARATES « the canonical form the verdict compared » FROM « the raw cell », under which a
		// bank that groups its IBAN one month and not the next would never be recognised.
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const grouped = accountMemoryKeyOf(statement('FR76 3000 1007 9412 3456 7890 185'), []);
		const joined = accountMemoryKeyOf(statement('FR7630001007941234567890185'), []);
		expect(grouped?.identifierKey).toBe(joined?.identifierKey);
		expect(grouped?.fragment).toBe('0185');
	});

	it('hands the key the whole identifier, not its fragment', () => {
		const rows = statement('FR7630001007941234567890185');
		const verdict = findDiscriminantColumn(rows);
		expect(verdict.kind).toBe('resolved');
		expect(verdict.kind === 'resolved' && statementIdentifier(rows, verdict)).toBe(
			'FR7630001007941234567890185'
		);
	});

	it('is null for a file naming no single identifier, and for one an account holds', () => {
		// SEPARATES « the memory applies only where the file names an identifier no account holds »
		// FROM « every file with an account column gets a key ».
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const silent: ParsedCsvRow[] = [
			{ cells: ['date', 'libelle', 'montant'], line: 1 },
			{ cells: ['2026-08-01', 'CARTE', '-3,10'], line: 2 }
		];
		expect(accountMemoryKeyOf(silent, [])).toBeNull();
		expect(
			accountMemoryKeyOf(statement('11110185'), [
				{ id: 'a', name: 'Courant', source: 'csv', archivedAt: null, discriminant: '0185' }
			])
		).toBeNull();
		expect(accountMemoryKeyOf(statement('11110185'), [])).not.toBeNull();
	});
});
