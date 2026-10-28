import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openCheckpoint, parseVkey, signCheckpoint, vkeyOf } from './note';

/**
 * The checkpoint format of the log seal (#875): C2SP signed-note, tlog-checkpoint and
 * tlog-cosignature, all at v1.1.0, with the ML-DSA-44 checkpoint cosignature (type 0x06).
 *
 * The oracle is a checkpoint signed by ANOTHER implementation, torchwood's Go `crypto/mldsa`
 * (fixture file, licence in its header), so a message layout this repository got wrong would fail
 * here while agreeing with itself in the round trip below.
 */

const fixture = readFileSync(new URL('./torchwood-mldsa-vector.txt', import.meta.url), 'utf8')
	.split('\n')
	.filter((line) => !line.startsWith('#'));
const GO_VKEY = fixture[0];
const GO_NOTE = `${fixture.slice(2, 7).join('\n')}\n`;
const ROOT = '+zoErtsZtGO6sfiSV/v4UJSIyowisE8hvjw0q5+bD38=';

describe('parseVkey', () => {
	// The base64 of a 1312-byte key holds `+` characters: a parser splitting on every `+` cuts the key
	// short. Separates a split at the first two separators from a split at all of them.
	it('reads a vkey whose base64 contains plus signs', () => {
		expect(GO_VKEY.split('+').length).toBeGreaterThan(3);
		const vkey = parseVkey(GO_VKEY);
		expect(vkey.name).toBe('example.com/mldsa-log');
		expect(vkey.keyId).toBe('b5df45c5');
	});

	it('refuses a key ID that is not the one its key and name give', () => {
		expect(() => parseVkey(GO_VKEY.replace('+b5df45c5+', '+b5df45c6+'))).toThrow(/key ID/);
	});
});

describe('openCheckpoint, on a checkpoint signed by torchwood', () => {
	it('opens it, with the origin, size, root and timestamp it signed', () => {
		const opened = openCheckpoint(GO_NOTE, parseVkey(GO_VKEY));
		expect(opened).toEqual({
			origin: 'example.com/mldsa-log',
			size: 1,
			root: Buffer.from(ROOT, 'base64'),
			timestamp: 0
		});
	});

	// Calibration: the same signature over a note one field off. Separates a verifier that checks
	// the size from one that only checks the signature parses.
	it('refuses it once the tree size is changed', () => {
		const forged = GO_NOTE.replace('\n1\n', '\n2\n');
		expect(openCheckpoint(forged, parseVkey(GO_VKEY))).toEqual({ refused: 'bad-signature' });
	});

	it('refuses a note with no signature from the given key', () => {
		const { publicKey } = generateKeyPairSync('ml-dsa-44');
		expect(openCheckpoint(GO_NOTE, parseVkey(vkeyOf('example.com/mldsa-log', publicKey)))).toEqual({
			refused: 'no-signature-from-key'
		});
	});
});

describe('signCheckpoint', () => {
	it('writes a note the verifier opens, with the timestamp it was given', () => {
		const { publicKey, privateKey } = generateKeyPairSync('ml-dsa-44');
		const root = Buffer.alloc(32, 7);
		const note = signCheckpoint(
			{ origin: 'budgetpilot/log/abc', size: 12, root, timestamp: 1_800_000_000 },
			{ name: 'budgetpilot/log', privateKey }
		);
		expect(note.split('\n').slice(0, 4)).toEqual(['budgetpilot/log/abc', '12', root.toString('base64'), '']);
		expect(openCheckpoint(note, parseVkey(vkeyOf('budgetpilot/log', publicKey)))).toEqual({
			origin: 'budgetpilot/log/abc',
			size: 12,
			root,
			timestamp: 1_800_000_000
		});
	});
});
