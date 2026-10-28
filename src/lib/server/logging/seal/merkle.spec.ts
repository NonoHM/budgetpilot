import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMerkleTree } from './merkle';

/**
 * The RFC 6962 tree the log seal is built on (#875), against vectors this repository did not
 * compute: `transparency-dev/merkle@c39fbf350a405f68571bf4c42a6a518eb0a46a4b`,
 * `testonly/constants.go` (Apache-2.0), `LeafInputs` and `RootHashes`, the vectors Certificate
 * Transparency's own implementations are tested on. Copied as hex, so the test shares no code with
 * the tree it checks.
 */

const LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
const ROOTS = [
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
	'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
	'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
	'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
	'4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
	'76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
	'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
	'5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328'
];

describe('createMerkleTree', () => {
	it('gives the published root at every size from 0 to 8', () => {
		const tree = createMerkleTree();
		const seen = [Buffer.from(tree.root()).toString('hex')];
		for (const leaf of LEAVES) {
			tree.append(Buffer.from(leaf, 'hex'));
			seen.push(Buffer.from(tree.root()).toString('hex'));
		}
		expect(seen).toEqual(ROOTS);
		expect(tree.size).toBe(8);
	});

	// Separates a tree that hashes leaves with the 0x00 prefix from one that hashes the bare bytes:
	// the size-1 root is SHA-256(0x00 || leaf), never SHA-256(leaf).
	it('prefixes a leaf with 0x00 before hashing it', () => {
		const tree = createMerkleTree();
		tree.append(Buffer.alloc(0));
		expect(Buffer.from(tree.root()).toString('hex')).not.toBe(
			createHash('sha256').update(Buffer.alloc(0)).digest('hex')
		);
		expect(Buffer.from(tree.root()).toString('hex')).toBe(ROOTS[1]);
	});
});
