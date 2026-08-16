const MOJIBAKE_PATTERN = /(?:Ã.|Â.|â[€™“”€¦])/;
const MOJIBAKE_FALLBACKS: Array<[RegExp, string]> = [
	[/Ã©/g, 'é'],
	[/Ã¨/g, 'è'],
	[/Ãª/g, 'ê'],
	[/Ã«/g, 'ë'],
	[/Ã‰/g, 'É'],
	[/Ãˆ/g, 'È'],
	[/Ã /g, 'à'],
	[/Ã¢/g, 'â'],
	[/Ã´/g, 'ô'],
	[/Ã»/g, 'û'],
	[/Ã¹/g, 'ù'],
	[/Ã§/g, 'ç'],
	[/Â /g, ' ']
];

export function normalizeImportedContent(content: string): string {
	return normalizeMojibakeText(content.replace(/^\uFEFF/, ''));
}

export function normalizeHeaderName(value: string): string {
	return normalizeMojibakeText(value).trim().replace(/\s+/g, ' ');
}

/**
 * The fold used to COMPARE a header against a name we know, accents included.
 *
 * Lived privately in `revolut.ts`, where it is what lets that profile match `Etat` against
 * `État`. It is shared rather than copied because `generic`'s alias table needs exactly the same
 * question answered, and it needed it badly: `resolveRequiredColumns` folded with
 * `trim().toLowerCase()` alone, so the alias `libelle` never matched `Libellé` — the commonest
 * French label header there is. Measured: `Date,Libellé,Montant,Catégorie` imported 0 of 4,
 * the identical file unaccented 4 of 4.
 *
 * ## Where this must NOT be used
 *
 * `mapping/fingerprint.ts` and `mapping/apply.ts` fold with `trim().toLowerCase()` and go on
 * doing so. That fingerprint is STORED, and it is how a memorised correspondance recognises the
 * same header row on a later upload: folding it differently changes every stored fingerprint at
 * once, and the symptom is « it forgot my designation » with nothing on screen to point at.
 * Two folds, deliberately, for two different jobs. `profiles/accentedHeaders.spec.ts` pins the
 * difference so a later tidy-up cannot unify them on the grounds that they look alike.
 *
 * Also distinct from `computeNameKey` (server/naming/nameKey.ts), which folds category NAMES:
 * that one answers "are these the same category", this one "is this the column I mean".
 */
/**
 * The other fold: case only, accents KEPT.
 *
 * Written out once because it was nine identical copies of one decision, spread across
 * `maison`, `maison-v2`, `mapped`, `mapping/fingerprint`, `mapping/apply` and `mapping/recap` —
 * and it is the decision that must not drift, because one of those nine is written to the
 * database.
 *
 * ## Why it does not fold accents, unlike `foldComparableHeader`
 *
 * Two different jobs, and the difference is which side of the comparison is fixed:
 *
 * - **A fixed ASCII list.** `maison` and `maison-v2` match their own export's header row byte
 *   for byte against a literal array. That format is a CONTRACT with files already on users'
 *   disks; there is no vocabulary of spellings to be generous about.
 * - **A stored value.** `fingerprintFor` is how a memorised correspondance recognises the same
 *   header row on a later upload, and it is persisted. Fold it differently and every stored
 *   fingerprint changes at once: the symptom is « it forgot my designation », with nothing on
 *   screen to point at and no error anywhere.
 *
 * `foldComparableHeader` is for the opposite case — matching a bank's arbitrary spelling against
 * a vocabulary we chose — and there, refusing `Libellé` because the alias is written `libelle`
 * is the defect rather than the safety.
 *
 * `profiles/accentedHeaders.spec.ts` pins the two apart so a later tidy-up cannot unify them on
 * the grounds that they look alike.
 */
export function foldExactHeader(value: string): string {
	return value.trim().toLowerCase();
}

export function foldComparableHeader(value: string): string {
	return normalizeMojibakeText(value)
		.trim()
		.replace(/\s+/g, ' ')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase();
}

export function normalizeMojibakeText(value: string): string {
	if (!MOJIBAKE_PATTERN.test(value)) return value;

	const bytes: number[] = [];
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 255) return applyMojibakeFallbacks(value);
		bytes.push(code);
	}

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
	} catch {
		return applyMojibakeFallbacks(value);
	}
}

function applyMojibakeFallbacks(value: string): string {
	return MOJIBAKE_FALLBACKS.reduce(
		(current, [pattern, replacement]) => current.replace(pattern, replacement),
		value
	);
}
