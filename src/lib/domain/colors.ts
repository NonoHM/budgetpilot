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
	'#8b5cf6': 'bg-[#8b5cf6]'
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
