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

// ---------------------------------------------------------------------------
// Referential V2 — three additions landed with the range-calendar chantier.
//
// These are RULES, not tokens, which is why they are prose here rather than
// exported strings: two of them govern components that carry no shared class
// (the calendar cell, the bottom sheet) and the third governs every breakpoint
// decision in the app. They are recorded here because this file is where the
// referential's rules already live in tracked code — the referential document
// itself is an external deliverable, cited by brick number.
//
// 1. NEW BRICK — Calendar cell.
//    Neither the radius brick nor the 44px brick described a 30px target in a
//    CONTINUOUS grid, which is why this had to be added rather than derived.
//    Eleven states (resting, today, start, end, in-range, candidate, candidate
//    edge, single day, outside month, unavailable, keyboard focus); two sizes,
//    30px for the mouse and 48px for the finger; bound radius 10 and 14; NO
//    hue at all — a date range is neither destructive nor overdue, and colour
//    in this product is reserved for those and for a tag's identity.
//    The strokes DO NOT SCALE between the sizes: candidate dashes stay 1px,
//    today's underline stays 2px, the focus ring stays 2+2px, and the gap
//    between cells stays 0 so the band reads as one segment. What grows is the
//    target, the radius and the digit. See `$lib/domain/rangeCalendar.ts`,
//    where the table and the strokes are one object precisely so this claim is
//    assertable whole.
//    Note for whoever revisits it: the design justifies the radii as "one third
//    of the cell", which is true at 30/10 and false at 48/14 (48/3 is 16). The
//    FIGURES are normative; the sentence is not.
//    Where: Période in the filter bar, both /reports periods, any future date.
//
// 2. NEW RULE — Sheet footer.
//    In a sheet, the primary action NEVER scrolls. It lives in a sticky footer
//    outside the scrolling zone, including when the virtual keyboard shrinks
//    the sheet. Consequence: no sheet is ever sized to "just fit" on some phone
//    model, and reaching the validation never depends on remaining height. A
//    sheet that fits on one handset breaks on the next one.
//
// 3. PRECEDENCE CLAUSE — the 44px floor.
//    At the mobile breakpoint, the 44px floor beats any smaller desktop value,
//    with no exception negotiable screen by screen. The 44px brick set the
//    number without saying who wins a conflict, which is what let three
//    triggers ship at 40px and one at 36px. Corollary, and it is the operative
//    half: a smaller desktop value is not a precedent, it is a value that has
//    not been brought down yet.
// ---------------------------------------------------------------------------
