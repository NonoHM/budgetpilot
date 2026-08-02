import { TAG_COLORS } from './colors';

/**
 * Palette token names, not indices and not hexes.
 *
 * A token survives a palette reorder, validates against a closed set so no off-palette or
 * inaccessible colour can ever be stored (including through a hand-edited backup file), and is
 * readable in the database. The hexes themselves live in domain/colors.ts with the other three
 * palettes, along with the reasoning for the hue spacing and the two locked tokens.
 *
 * Numbered rather than named after their hue on purpose: the design names them in French (Terre,
 * Ocre, Olive, Lagune, Azur, Ardoise, Indigo, Prune, Vigne) and identifiers in this codebase are
 * English. The hue name is recorded beside each hex in colors.ts, which is where it is useful.
 */
export const TAG_COLOR_TOKENS = [
	'tag-1',
	'tag-2',
	'tag-3',
	'tag-4',
	'tag-5',
	'tag-6',
	'tag-7',
	'tag-8',
	'tag-9'
] as const;

export type TagColorToken = (typeof TAG_COLOR_TOKENS)[number];

export function isTagColorToken(value: unknown): value is TagColorToken {
	return typeof value === 'string' && (TAG_COLOR_TOKENS as readonly string[]).includes(value);
}

/**
 * Deterministic colour assignment, so creating a tag stays "type a name" with no colour decision.
 *
 * Same hash shape as resolveCategoryColor in domain/colors.ts, applied to the nameKey rather than
 * the display name: the same tag renamed only in case or accents keeps its colour, because that is
 * the same tag as far as the unique constraint is concerned.
 */
export function pickTagColorToken(nameKey: string): TagColorToken {
	let h = 0;
	for (let i = 0; i < nameKey.length; i++) h = ((h << 5) - h + nameKey.charCodeAt(i)) | 0;
	return TAG_COLOR_TOKENS[Math.abs(h) % TAG_COLOR_TOKENS.length];
}

/**
 * 60, the same bound MAX_MANUAL_CATEGORY_LENGTH already uses for a manual category name
 * (routes/transactions/+page.server.ts). Not a new number.
 *
 * The backup validator bounds Tag.name at MAX_PORTABLE_STRING (191) instead, deliberately: that
 * bound describes what any version may have written, not what this one produces. See the comment
 * on MAX_PORTABLE_STRING in server/backup/schema.ts.
 */
export const MAX_TAG_NAME_LENGTH = 60;

/**
 * How many tags one transaction may carry.
 *
 * Invisible in practice: TagChips shows 2 and collapses the rest, and a transaction with ten tags
 * is already past any real use case. It exists so the backup validator can bound the
 * transactionTags array RELATIVE to the transactions array
 * (transactionTags.length <= transactions.length * MAX_TAGS_PER_TRANSACTION).
 *
 * That relative bound is what lets the restore refuse a hand-edited amplification without ever
 * refusing a legal export, which is the failure mode the absolute bound on recurringStreamActions
 * had to work around with a 2x headroom gap. Every tagged transaction leaves the bulk createMany
 * and gets its own create, so an unbounded pair array is the same availability problem that
 * comment describes.
 */
export const MAX_TAGS_PER_TRANSACTION = 10;

/**
 * The one normalizer for a user-supplied tag name.
 *
 * Whitespace runs collapse so "Vacances  Portugal" and "Vacances Portugal" are not two tags whose
 * difference nobody can see. Truncation rather than rejection above the cap, matching how every
 * other cap in this codebase degrades. Returns '' for whitespace-only input; callers treat '' as
 * "no tag" and must not create a row for it.
 */
export function normalizeTagName(raw: string): string {
	return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_NAME_LENGTH);
}

export type TagColorHex = (typeof TAG_COLORS)[TagColorToken];
