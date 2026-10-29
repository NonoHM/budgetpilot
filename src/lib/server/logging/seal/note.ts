import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * The checkpoint of the log seal (#875) as a C2SP signed note, and nothing else:
 * `c2sp.org/signed-note@v1.1.0` for the envelope, `c2sp.org/tlog-checkpoint@v1.1.0` for the body
 * and the 0x06 vkey, `c2sp.org/tlog-cosignature@v1.1.0` for the signed message. Copies of the
 * three specifications live with the design record of #875.
 *
 * THE SIGNED MESSAGE. An ML-DSA-44 cosignature does not sign the note text. It signs
 * `CosignedSubtree`: the label `subtree/v1\n\0`, the cosigner name and the origin each with a
 * one-byte length, a big-endian uint64 timestamp, start 0, end the tree size, and the 32-byte root.
 * The signature line value is key ID (4) || timestamp (8) || signature (2420). Extension lines are
 * not signed by this type, so a note carrying any is refused rather than half verified.
 *
 * Checked against a checkpoint signed by torchwood's Go `crypto/mldsa` (`note.spec.ts`).
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

const SIGNATURE_TYPE = 0x06;
const PUBLIC_KEY_BYTES = 1312;
const SIGNATURE_BYTES = 2420;
const LABEL = Buffer.from('subtree/v1\n\0', 'latin1');
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** A key name or origin: non-empty, no Unicode space, no plus, no control character. */
const NAME = /^[^\s+\p{Cc}]+$/u;

export interface Vkey {
	name: string;
	keyId: string;
	publicKey: KeyObject;
}

export interface CheckpointFields {
	origin: string;
	size: number;
	root: Buffer;
	/** Seconds since the epoch, as the signer's clock read it. */
	timestamp: number;
}

export type CheckpointRefusal = {
	refused: 'malformed' | 'extension-lines' | 'no-signature-from-key' | 'bad-signature';
};

/** Canonical base64 only (signed-note: « decoders MUST reject non-canonical encodings »). */
function decodeBase64(text: string): Buffer | undefined {
	if (!BASE64.test(text) || text.length % 4 !== 0) return undefined;
	const bytes = Buffer.from(text, 'base64');
	return bytes.toString('base64') === text ? bytes : undefined;
}

function validName(name: string): boolean {
	return NAME.test(name) && Buffer.byteLength(name, 'utf8') <= 255;
}

function keyIdOf(name: string, rawKey: Buffer): Buffer {
	return createHash('sha256')
		.update(name, 'utf8')
		.update(Uint8Array.of(0x0a, SIGNATURE_TYPE))
		.update(rawKey)
		.digest()
		.subarray(0, 4);
}

function cosignedSubtree(name: string, fields: CheckpointFields): Buffer {
	const nameBytes = Buffer.from(name, 'utf8');
	const originBytes = Buffer.from(fields.origin, 'utf8');
	const numbers = Buffer.alloc(8);
	const u64 = (value: number) => {
		numbers.writeBigUInt64BE(BigInt(value));
		return Buffer.from(numbers);
	};
	return Buffer.concat([
		LABEL,
		Uint8Array.of(nameBytes.length),
		nameBytes,
		u64(fields.timestamp),
		Uint8Array.of(originBytes.length),
		originBytes,
		u64(0),
		u64(fields.size),
		fields.root
	]);
}

/** Reads `<name>+<key ID>+<base64 of 0x06 || key>`. Split at the first two `+` only: base64 has them. */
export function parseVkey(text: string): Vkey {
	const trimmed = text.trim();
	const first = trimmed.indexOf('+');
	const second = trimmed.indexOf('+', first + 1);
	if (first < 1 || second < 0) throw new Error('A verification key reads <name>+<key ID>+<key>.');
	const name = trimmed.slice(0, first);
	const keyId = trimmed.slice(first + 1, second);
	const material = decodeBase64(trimmed.slice(second + 1));
	if (!validName(name)) throw new Error('The verification key name is not a valid note key name.');
	if (!/^[0-9a-f]{8}$/.test(keyId)) throw new Error('The key ID is not 8 hex digits.');
	if (!material || material[0] !== SIGNATURE_TYPE || material.length !== 1 + PUBLIC_KEY_BYTES) {
		throw new Error('The verification key is not an ML-DSA-44 checkpoint key (type 0x06).');
	}
	const rawKey = material.subarray(1);
	if (keyIdOf(name, rawKey).toString('hex') !== keyId) {
		throw new Error('The key ID is not the one this key and name give.');
	}
	const publicKey = createPublicKey({
		key: rawKey,
		format: 'raw-public',
		asymmetricKeyType: 'ml-dsa-44'
	});
	return { name, keyId, publicKey };
}

/** The vkey of an ML-DSA-44 public key under `name`. */
export function vkeyOf(name: string, publicKey: KeyObject): string {
	const rawKey = publicKey.export({ format: 'raw-public' });
	const keyId = keyIdOf(name, rawKey).toString('hex');
	return `${name}+${keyId}+${Buffer.concat([Uint8Array.of(SIGNATURE_TYPE), rawKey]).toString('base64')}`;
}

/** The checkpoint note for `fields`, signed once by `signer`. */
export function signCheckpoint(
	fields: CheckpointFields,
	signer: { name: string; privateKey: KeyObject }
): string {
	const rawKey = createPublicKey(signer.privateKey).export({ format: 'raw-public' });
	const timestamp = Buffer.alloc(8);
	timestamp.writeBigUInt64BE(BigInt(fields.timestamp));
	const signature = sign(null, cosignedSubtree(signer.name, fields), signer.privateKey);
	const value = Buffer.concat([keyIdOf(signer.name, rawKey), timestamp, signature]).toString(
		'base64'
	);
	return `${fields.origin}\n${fields.size}\n${fields.root.toString('base64')}\n\n— ${signer.name} ${value}\n`;
}

/** The fields a checkpoint signed by `vkey` commits to, or why it does not open. */
export function openCheckpoint(note: string, vkey: Vkey): CheckpointFields | CheckpointRefusal {
	const split = note.indexOf('\n\n');
	if (split < 0 || !note.endsWith('\n')) return { refused: 'malformed' };
	const body = note.slice(0, split).split('\n');
	if (body.length > 3) return { refused: 'extension-lines' };
	const [origin, sizeText, rootText] = body;
	const root = rootText === undefined ? undefined : decodeBase64(rootText);
	if (
		body.length !== 3 ||
		!validName(origin) ||
		!DECIMAL.test(sizeText) ||
		!Number.isSafeInteger(Number(sizeText)) ||
		root?.length !== 32
	) {
		return { refused: 'malformed' };
	}
	const signatures = note.slice(split + 2, -1).split('\n');
	for (const line of signatures) {
		const match = /^— (\S+) (\S+)$/u.exec(line);
		if (!match) return { refused: 'malformed' };
		if (match[1] !== vkey.name) continue;
		const value = decodeBase64(match[2]);
		if (!value || value.length < 4 || value.subarray(0, 4).toString('hex') !== vkey.keyId) continue;
		if (value.length !== 4 + 8 + SIGNATURE_BYTES) return { refused: 'bad-signature' };
		const timestamp = value.readBigUInt64BE(4);
		if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) return { refused: 'bad-signature' };
		const fields = { origin, size: Number(sizeText), root, timestamp: Number(timestamp) };
		const ok = verify(null, cosignedSubtree(vkey.name, fields), vkey.publicKey, value.subarray(12));
		return ok ? fields : { refused: 'bad-signature' };
	}
	return { refused: 'no-signature-from-key' };
}
