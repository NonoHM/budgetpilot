import { TAG_COLORS } from './colors';

/**
 * Palette token names, not indices and not hexes.
 *
 * A token survives a palette reorder, validates against a closed set so no off-palette or
 * inaccessible colour can ever be stored (including through a hand-edited backup file), and is
 * readable in the database. The hexes themselves live in domain/colors.ts with the other three
 * palettes, along with the reasoning for the hue spacing and the two locked tokens.
 *
 * Named after their hue rather than numbered. The design requires the hue name in the accessible
 * name of every swatch ("Lagoon", never "colour 4"), so a numbered token would need a second table
 * mapping index to display name, which is the duplicated-source shape this project has already
 * watched drift more than once. One name per token, used in the column, in the aria-label and in
 * the docs. Capitalisation for display is derived at the render site, not stored, so this list
 * stays the only place the set is written down.
 *
 * English, like every other palette key in domain/colors.ts (`income`, `checking`, `real_estate`).
 * The design names them in French; three are not literal translations, and the reasons are worth
 * keeping. `steel` renders the design's "Ardoise" because English "slate" is a grey in every
 * convention a reader would bring to it, Tailwind's included, while this token is a mid blue.
 * `berry` renders "Vigne" because "vine" reads green in English and this token is a magenta.
 * `clay` renders "Terre" because "earth" reads brown rather than the muted brick red it is.
 */
export const TAG_COLOR_TOKENS = [
	'clay',
	'ochre',
	'olive',
	'lagoon',
	'azure',
	'steel',
	'indigo',
	'plum',
	'berry'
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
 *
 * Control and format characters are removed FIRST, and that step is not decoration. `\s` does not
 * match U+200B, so without it "Portu<ZWSP>gal" and "Portugal" get different nameKeys and become
 * two tags whose difference nobody can see, which is the exact failure the collapse above exists
 * to prevent. The same class covers bidi overrides such as U+202E, which let a stored name render
 * as a different one: the delete confirmation names the tag it is about to destroy, so a
 * spoofable label there is a hazard rather than a cosmetic problem.
 *
 * Deliberately does NOT reject `<` and `>`, unlike parseManualCategory in
 * routes/transactions/+page.server.ts, which validates the same class of user-authored free text.
 * The difference is intentional: a category name is a taxonomy term, while a tag is a label a user
 * writes for themselves and may legitimately contain "Q1<->Q2" or "R&D". Every render path escapes,
 * so the angle brackets buy nothing. Anything unescaped is a new sink and needs its own decision.
 */
export function normalizeTagName(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.trim()
		.replace(/\s+/g, ' ')
		.slice(0, MAX_TAG_NAME_LENGTH);
}

export type TagColorHex = (typeof TAG_COLORS)[TagColorToken];

/**
 * How many transactions one bulk action may tag.
 *
 * A SEPARATE constant from MAX_TRANSACTION_ID_FILTER, not an import of it, following the precedent
 * that constant's own comment sets: how many rows one action may tag is a domain fact about what a
 * user can reasonably confirm in a dialog, while how many ids an `IN (...)` may carry is a property
 * of the query layer. Two facts that happen to share a number today.
 *
 * They are not independent, though, and bulk.spec.ts asserts the relation rather than the equality:
 * the undo payload is the list of ids this action linked, and it travels back through the same
 * id-list parser. If this cap ever exceeded that one, an undo would silently truncate and leave
 * rows tagged with no way back. That is the failure worth preventing.
 */
export const MAX_BULK_TAG_TRANSACTIONS = 250;
