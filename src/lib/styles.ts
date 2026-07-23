// Canonical variants for form field styling across BudgetPilot.
//
// Component referential rule (single field template, all breakpoints):
// 44px height (h-11), 12px radius (rounded-xl), 1px zinc-200 border.
// Select.svelte / Combobox.svelte / MoneyInput.svelte carry the same values
// on their own base classes — change them together, never one alone.
//
//  inputBase      — modal and full-page forms
//  inputFilter    — filter bars / toolbars (same template; kept as a separate
//                   export so toolbar-specific tweaks stay one-line if ever needed)
//  inputTableMini — inline selects within table rows — px-2 py-1, the ONLY
//                   deliberate exception to the 44px rule (a full-height field
//                   would distort table row height)
//  inputSearchPill — standalone search-by-label fields (SearchBar.svelte)
//
// Compose with layout / modifier classes as needed:
//   class="{inputBase} w-full tabular-nums"
//   class="w-full {inputBase} pr-8 ..."  ← pr-X overrides the pr-3 from px-3 in Tailwind JIT

export const inputBase =
	'h-11 rounded-xl border border-zinc-200 bg-white px-3 text-sm focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400';

export const inputFilter = inputBase;

// Intentionally compact (px-2 py-1) for inline selects embedded in table rows
// where full-height fields would distort row height.
export const inputTableMini =
	'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400';

export const inputSearchPill = inputBase;

// Button height rule (referential): Button's own size scale (sm/md/lg) is
// padding-based and never lands on 44px (32/36/40px). Whenever a Button sits
// in the same row as a Select/Combobox/MoneyInput/SearchBar/inputBase field
// (filter bars, inline forms, action rows next to a period/date selector),
// use Button's size="field" (h-11, exact 44px match) instead of a local
// `class="h-11"` override — a prior per-page override (`h-11 ... lg:h-auto`)
// silently reverted to the wrong height at the lg breakpoint.

// Canonical top-level card shell: rounded-3xl (24px) on mobile, rounded-lg
// (8px) on desktop, single 1px zinc-200 border, never a box-shadow (cards are
// flat by design — no elevation styling). Padding stays at the call site
// since it varies (p-4, p-5, px-6 py-16, ...).
export const cardBase = 'rounded-3xl border border-zinc-200 bg-white lg:rounded-lg';

// Shared hover/press transition token (component referential V2's final
// brick, see src/lib/motion.ts for the Dropdown/Tooltip/Modal/AlertBanner
// open/close timings): Button, IconButton, TapLink, ListCard. Falls back to
// an instant state change under prefers-reduced-motion instead of just
// slowing down.
export const transitionHover =
	'transition-colors duration-[120ms] ease-out motion-reduce:transition-none motion-reduce:duration-0';
