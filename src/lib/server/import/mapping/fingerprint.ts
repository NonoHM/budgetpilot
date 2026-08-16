import { createHash } from 'node:crypto';
import { foldExactHeader } from '../utils/encoding';

/**
 * How a remembered mapping finds its columns again in a later file.
 *
 * `name` resolves each role by the column's header text, `position` by its index. See
 * `fingerprintFor` for why the two cannot share a canonical form.
 */
export type ColumnMatchBy = 'name' | 'position';

/**
 * The identity of a file's header row, as a full SHA-256 digest in 64 lowercase hex characters.
 *
 * ## What the canonical form is, and why it depends on `matchBy`
 *
 * **`name`: the cells are SORTED.** A mapping that resolves its roles by header text does not care
 * what order the bank writes its columns in, so neither should its key: a column inserted in the
 * middle, or a bank reordering its export, must still find the mapping. Sorting is what buys that.
 *
 * **`position`: the cells are kept IN FILE ORDER.** A mapping that resolves its roles by INDEX
 * cares about nothing else. If it were keyed on a sorted digest, a reordered file would carry the
 * same fingerprint, the mapping would be found, and its stored indices would point at different
 * columns: amounts read out of the date column, silently, on a file that looks fine. That is the
 * exact failure the design plate warns about when it requires the recap to say « mémorisée par
 * position », and the warning is not a substitute for the key being right.
 *
 * The two spaces are domain-separated by a prefix, so a name digest can never equal a position
 * digest even for a file whose columns are already in sorted order.
 *
 * ## Why the cells are LENGTH PREFIXED rather than joined by a separator
 *
 * Two measurements, both taken on the first shipped version of this function, which joined the
 * cells with a literal NUL byte.
 *
 * **A separator character can be imitated by a cell that contains it.** Measured: `['a\u0000b']`
 * and `['a', 'b']` produced the byte-identical digest
 * `cabbee7cea24c0a5426e7021e5dcf54cde61eb2ef9e7a2f805bceb02cfd320af`. NUL is a rare character in
 * a bank's header row and it is not an impossible one, because a CSV cell carries whatever bytes
 * the file carries. Every candidate separator is a bet about what a file will never contain, and
 * a length prefix is not a bet: the length is read first, so nothing inside the cell can end it.
 *
 * **And a literal NUL byte in a SOURCE file makes that file invisible to every text search.** This
 * repository has measured that once already (`mergePlan.ts`, which cost a whole audit's scope
 * figure to discover), and the comment that used to sit at the return statement here said "never a
 * literal NUL byte" while being written with two of them. `grep` found nothing in this file, which
 * is exactly how the defect above survived review. Length prefixing needs no escape, so the
 * question does not arise.
 *
 * ## What collides, and what that costs
 *
 * Three cases, and only the third is reachable.
 *
 * **An accidental hash collision is unreachable.** The digest is the full 256 bits, never
 * truncated (#316 displays twelve hex characters in a measurement; that is a display, not a key).
 * Against the per-user cap of 50 mappings the birthday bound is about 50^2 / 2^257, which is
 * around 10^-74. Truncating to the twelve characters that measurement shows would make it 50^2 /
 * 2^49, still about 10^-12, and the reason not to is that there is no benefit to weigh it against.
 *
 * **A deliberate collision buys nothing.** It needs a SHA-256 collision, and the key is
 * `(userId, fingerprint)`, so a user who found one could only apply one of their own mappings to
 * another of their own files.
 *
 * **A collision BY DESIGN is reachable, and it is the intended behaviour rather than a hazard.**
 * Two files whose header cells trim and lowercase to the same multiset have the same fingerprint,
 * by construction: that is what makes this a shape rather than a file. Two banks that both emit
 * `date;libelle;montant` genuinely are the same shape, and a mapping made for one resolves
 * correctly for the other, because `name` matching resolves by text and `applyColumnMapping`
 * re-verifies that each stored column is present before applying anything.
 *
 * The case that is NOT safe is the same collision under `position` matching, and the paragraph
 * above is why that space is ordered rather than sorted. Order-sensitivity does not make a
 * positional mapping safe on its own, only less wrong: it is a weaker guarantee than name
 * matching, it is why the recap has to say so, and it is why `applyColumnMapping` also checks the
 * column count before applying indices.
 */
export function fingerprintFor(headers: string[], matchBy: ColumnMatchBy): string {
	const cells = headers.map(foldExactHeader);
	const canonical = matchBy === 'name' ? [...cells].sort() : cells;

	// LENGTH PREFIXED, with no separator character at all. See the docstring section above for
	// the two measurements that decided this: a separator can be imitated by a cell that contains
	// it, and writing that separator as a literal NUL byte makes this file invisible to grep.
	// Reading the length first is what makes the encoding injective, so a colon inside a cell is
	// data rather than a delimiter. Do not "simplify" this into a join.
	const encoded = canonical.map((cell) => `${cell.length}:${cell}`).join('');

	// `name` and `position` are distinct fixed literals and neither is a prefix of the other, so
	// this is the domain separation described above.
	return createHash('sha256').update(`${matchBy}:${encoded}`, 'utf8').digest('hex');
}

/**
 * Both fingerprints a file could be remembered under, for the lookup that does not yet know which
 * kind of mapping it is looking for.
 *
 * A caller queries `(userId, fingerprint IN these)`. Two values rather than one because the two
 * canonical forms are deliberately different, and one query rather than two because the pair is
 * still covered by `@@unique([userId, fingerprint])`.
 */
export function candidateFingerprints(headers: string[]): [string, string] {
	return [fingerprintFor(headers, 'name'), fingerprintFor(headers, 'position')];
}
