import { createHash } from 'node:crypto';

/**
 * The RFC 6962 Merkle tree of one log seal segment (#875), kept as a compact range: the roots of
 * the perfect subtrees the leaves so far decompose into, largest first, so memory is one hash per
 * set bit of the size rather than one per line.
 *
 * Leaf hash `SHA-256(0x00 || leaf)`, node hash `SHA-256(0x01 || left || right)` (RFC 6962, 2.1).
 * Folding the subtree roots from the right gives the tree's root at any size, because RFC 6962
 * splits at the largest power of two below n, which is exactly where the first subtree ends.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

export interface MerkleTree {
	append: (leaf: Uint8Array) => void;
	readonly size: number;
	root: () => Buffer;
}

const sha256 = (...parts: Uint8Array[]): Buffer => {
	const hash = createHash('sha256');
	for (const part of parts) hash.update(part);
	return hash.digest();
};

const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);

export function createMerkleTree(): MerkleTree {
	const subtrees: { hash: Buffer; height: number }[] = [];
	let size = 0;
	return {
		append(leaf) {
			let carry = { hash: sha256(LEAF, leaf), height: 0 };
			while (subtrees.length > 0 && subtrees[subtrees.length - 1].height === carry.height) {
				const left = subtrees.pop()!;
				carry = { hash: sha256(NODE, left.hash, carry.hash), height: carry.height + 1 };
			}
			subtrees.push(carry);
			size += 1;
		},
		get size() {
			return size;
		},
		root() {
			if (subtrees.length === 0) return sha256();
			let hash = subtrees[subtrees.length - 1].hash;
			for (let i = subtrees.length - 2; i >= 0; i--) hash = sha256(NODE, subtrees[i].hash, hash);
			return hash;
		}
	};
}
