// Distinct colors for category donut/progress bars — one per category slot
export const CATEGORY_PALETTE = ['#6366f1', '#f43f5e', '#f59e0b', '#10b981', '#0ea5e9'];
export const CATEGORY_PALETTE_OTHERS = '#d4d4d8';

// Semantic colors by transaction nature — aligned with app theme
// spending/refund match text-rose-600/text-emerald-600 used for amounts
// investment matches text-indigo-600 used for savings rate
// income uses emerald-500, distinct from refund's emerald-600
// transfer/fee/uncategorized use zinc neutral shades
export const NATURE_COLORS: Record<string, string> = {
	income: '#10b981', // emerald-500 — distinct from refund's emerald-600
	spending: '#e11d48', // rose-600 — matches text-rose-600 (expense amounts)
	investment: '#4f46e5', // indigo-600 — matches text-indigo-600 (savings rate)
	transfer: '#a1a1aa', // zinc-400
	refund: '#059669', // emerald-600 — matches text-emerald-600 (income amounts)
	fee: '#71717a', // zinc-500
	uncategorized: '#d4d4d8' // zinc-300
};

// Colors for the net-worth assets donut (checking/savings/investment/real_estate/other) — a
// distinct palette from CATEGORY_PALETTE so the two donuts (expense categories vs. asset
// types) never look like they encode the same concept, while staying in the same
// blue/teal/violet/amber/zinc families already used elsewhere in the app.
export const NET_WORTH_TYPE_COLORS: Record<
	'checking' | 'savings' | 'investment' | 'real_estate' | 'other',
	string
> = {
	checking: '#3b82f6', // blue-500
	savings: '#14b8a6', // teal-500
	investment: '#8b5cf6', // violet-500
	real_estate: '#f59e0b', // amber-500
	other: '#a1a1aa' // zinc-400
};

// A FOURTH palette, deliberately distinct from the three above, for transverse tags.
//
// Do not "simplify" this back into CATEGORY_PALETTE. The comment on NET_WORTH_TYPE_COLORS above
// records why two concepts never share a palette: the two donuts must not look like they encode
// the same thing. That argument is STRONGER here, not weaker. A tag dot and a category pastille
// render on the SAME transaction row, inches apart, so sharing a palette would make one colour
// mean "category X" in one column and "tag Y" in the next. The two are separated by rendering as
// well as by hue: a category pastille is a light saturated tone, a tag dot is a deep desaturated
// one.
//
// Generated, not hand-picked. Every dot is oklch(0.515 0.115 H) and every tint is
// oklch(0.968 0.024 H), so the nine tokens differ only in hue and therefore carry identical
// weight. Picking hexes by eye is what produces a palette where one tag looks more important
// than another.
//
// THREE HUE BANDS ARE DELIBERATELY ABSENT so a tag can never read as a status: the danger band
// around pure red, the warning band around amber, and the success band around green. The 82
// degree gap between olive (108) and lagoon (190) is that success band. Do not "fill the gap" and
// do not add a tenth token. A tag names a trip or a project; it must never be mistaken for the
// app telling the user something is wrong, late, or fine.
//
// LAGOON AND AZURE ARE LOCKED, exactly like the amber pair recorded in UpcomingBillsCard. They
// measure 4.71:1 and 4.81:1 for their name text on their own tint, which clears WCAG AA with the
// least room of the nine. Never lighten the hue, never lighten the tint, never apply opacity to
// either. Every ratio is asserted against the value the design measured in domain/tags.spec.ts,
// and one is checked as actually rendered in e2e/tags.spec.ts, because the unit test alone passes
// even if the Tailwind class binding is wrong.
export const TAG_COLORS = {
	clay: '#9f4949', // hue 22
	ochre: '#9c4f29', // hue 45
	olive: '#6e6b00', // hue 108
	lagoon: '#007b76', // hue 190 (locked, see above)
	azure: '#007693', // hue 218 (locked, see above)
	steel: '#266ba6', // hue 248
	indigo: '#625ca6', // hue 285
	plum: '#835092', // hue 318
	berry: '#934a7a' // hue 342
} as const;

// The tinted chip surface each dot sits on, same hue, oklch(0.968 0.024 H). Paired one-to-one with
// TAG_COLORS above: changing a hue means changing both, and the measured-ratio test goes red until
// they agree again.
//
// USED IN EXACTLY TWO PLACES, and the design says "deux, et seulement deux": the active state of
// the tag filter on /transactions, and the pill naming the tag in the bulk-apply ConfirmDialog.
// Everywhere else the colour does not leave the 8px dot — a row, a card or a modal never takes a
// tag's tint. Both call sites render the tag NAME in tagColorTextClass on this surface, which is
// the pairing the measured ratios above describe; e2e/tags.spec.ts measures those two rendered
// elements rather than the constants.
//
// These were briefly declared and never called, which made the ratios above describe a rendering
// that existed nowhere and left this table looking like dead code. If a future change removes the
// last caller, delete the surfaces deliberately or leave them called — do not let the table drift
// back into being unreferenced.
export const TAG_TINT_COLORS = {
	clay: '#ffefed',
	ochre: '#fff0e7',
	olive: '#f6f6e4',
	lagoon: '#e3faf8',
	azure: '#e4f9ff',
	steel: '#e8f6ff',
	indigo: '#f2f3ff',
	plum: '#fcf0ff',
	berry: '#ffeef9'
} as const;

/**
 * Class-based counterparts of TAG_COLORS and TAG_TINT_COLORS, for the same CSP reason as
 * hexToBgClass above: the class strings are written out literally in HEX_TO_BG_CLASS so Tailwind's
 * build-time scanner finds them.
 *
 * Changing a hex above is therefore TWO edits, here and in HEX_TO_BG_CLASS. A spec asserts every
 * token resolves to a class, so a half-landed palette change goes red rather than rendering an
 * uncoloured dot.
 */
export function tagColorBgClass(token: keyof typeof TAG_COLORS): string {
	return hexToBgClass(TAG_COLORS[token]);
}

export function tagTintBgClass(token: keyof typeof TAG_TINT_COLORS): string {
	return hexToBgClass(TAG_TINT_COLORS[token]);
}

/**
 * The token's own hue as TEXT, for the two surfaces that render a name on the matching tint.
 *
 * Its own literal table rather than a derivation of TAG_COLORS, for the same reason
 * HEX_TO_BG_CLASS is one: Tailwind's scanner reads source text, so `text-[${hex}]` compiles to
 * nothing. Changing a hue is now THREE edits (TAG_COLORS, HEX_TO_BG_CLASS, here) and
 * colors.spec.ts asserts every token resolves in all three, so a half-landed change goes red
 * instead of rendering invisible text on a coloured surface.
 *
 * This pairing is exactly what the measured contrast figures describe: the dot colour as text on
 * its own tint, 4.71:1 for lagoon and 4.81:1 for azure. Nothing else in the app may use it.
 */
const TAG_TEXT_CLASSES = {
	clay: 'text-[#9f4949]',
	ochre: 'text-[#9c4f29]',
	olive: 'text-[#6e6b00]',
	lagoon: 'text-[#007b76]',
	azure: 'text-[#007693]',
	steel: 'text-[#266ba6]',
	indigo: 'text-[#625ca6]',
	plum: 'text-[#835092]',
	berry: 'text-[#934a7a]'
} as const;

export function tagColorTextClass(token: keyof typeof TAG_COLORS): string {
	return TAG_TEXT_CLASSES[token];
}

// Stable per-category color for swatches/badges, independent of sort order (used in
// /transactions and /categories) — unlike the index-based CATEGORY_PALETTE usage in
// /reports, this hashes the category name so a given category always gets the same color.
export function resolveCategoryColor(categoryName: string, uncategorizedName: string): string {
	if (!categoryName || categoryName === uncategorizedName) return CATEGORY_PALETTE_OTHERS;
	let h = 0;
	for (let i = 0; i < categoryName.length; i++) h = ((h << 5) - h + categoryName.charCodeAt(i)) | 0;
	return CATEGORY_PALETTE[Math.abs(h) % CATEGORY_PALETTE.length];
}

// Every hex value used across CATEGORY_PALETTE/CATEGORY_PALETTE_OTHERS/NATURE_COLORS/
// NET_WORTH_TYPE_COLORS is fixed at build time (no user-supplied color ever reaches these
// tables), so each one can be mapped to a static Tailwind arbitrary-value class instead of a
// CSP-unfriendly inline `style="background: ..."`. The classes are written out literally
// (not built by string concatenation) so Tailwind's build-time scanner can find them.
const HEX_TO_BG_CLASS: Record<string, string> = {
	'#6366f1': 'bg-[#6366f1]',
	'#f43f5e': 'bg-[#f43f5e]',
	'#f59e0b': 'bg-[#f59e0b]',
	'#10b981': 'bg-[#10b981]',
	'#0ea5e9': 'bg-[#0ea5e9]',
	'#d4d4d8': 'bg-[#d4d4d8]',
	'#e11d48': 'bg-[#e11d48]',
	'#4f46e5': 'bg-[#4f46e5]',
	'#a1a1aa': 'bg-[#a1a1aa]',
	'#059669': 'bg-[#059669]',
	'#71717a': 'bg-[#71717a]',
	'#3b82f6': 'bg-[#3b82f6]',
	'#14b8a6': 'bg-[#14b8a6]',
	'#8b5cf6': 'bg-[#8b5cf6]',
	// Tag palette dots (TAG_COLORS). Written out literally, like every entry above: Tailwind's
	// scanner cannot see a class name built by concatenation.
	'#9f4949': 'bg-[#9f4949]',
	'#9c4f29': 'bg-[#9c4f29]',
	'#6e6b00': 'bg-[#6e6b00]',
	'#007b76': 'bg-[#007b76]',
	'#007693': 'bg-[#007693]',
	'#266ba6': 'bg-[#266ba6]',
	'#625ca6': 'bg-[#625ca6]',
	'#835092': 'bg-[#835092]',
	'#934a7a': 'bg-[#934a7a]',
	// Tag palette tints (TAG_TINT_COLORS), the chip surface each dot above sits on.
	'#ffefed': 'bg-[#ffefed]',
	'#fff0e7': 'bg-[#fff0e7]',
	'#f6f6e4': 'bg-[#f6f6e4]',
	'#e3faf8': 'bg-[#e3faf8]',
	'#e4f9ff': 'bg-[#e4f9ff]',
	'#e8f6ff': 'bg-[#e8f6ff]',
	'#f2f3ff': 'bg-[#f2f3ff]',
	'#fcf0ff': 'bg-[#fcf0ff]',
	'#ffeef9': 'bg-[#ffeef9]'
};

// Falls back to the neutral "others" swatch class if a hex value somehow isn't in the
// table above — should never happen since every caller sources its color from the fixed
// palettes in this module, but keeps this total rather than throwing on a lookup miss.
export function hexToBgClass(hex: string): string {
	return HEX_TO_BG_CLASS[hex] ?? HEX_TO_BG_CLASS[CATEGORY_PALETTE_OTHERS];
}

// Class-based counterpart of resolveCategoryColor(), for callers that need a CSP-compliant
// `class` instead of a `style="background: ..."` attribute.
export function resolveCategoryColorClass(categoryName: string, uncategorizedName: string): string {
	return hexToBgClass(resolveCategoryColor(categoryName, uncategorizedName));
}
