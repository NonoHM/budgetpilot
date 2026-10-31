---
name: BudgetPilot
description: Local-first personal budgeting, an Operate surface on stock Tailwind 4
# Values are Tailwind 4.3.3's own theme (node_modules/tailwindcss/theme.css); the app defines no
# custom theme, so a Tailwind class name is the token and these values follow the installed version.
colors:
  ink: 'oklch(14.1% 0.005 285.823)' # zinc-950, primary action fill, strongest text
  text: 'oklch(21% 0.006 285.885)' # zinc-900, body text
  text-muted: 'oklch(55.2% 0.016 285.938)' # zinc-500, secondary text
  border: 'oklch(92% 0.004 286.32)' # zinc-200, every card and field
  surface: '#fff' # white, cards and fields
  surface-sunken: 'oklch(98.5% 0 none)' # zinc-50, page ground and table stripes
  surface-hover: 'oklch(96.7% 0.001 286.375)' # zinc-100
  negative: 'oklch(58.6% 0.253 17.585)' # rose-600, spending, errors, destructive actions
  positive: 'oklch(59.6% 0.145 163.225)' # emerald-600, income and refunds
  warning: 'oklch(55.5% 0.163 48.998)' # amber-700, text on amber-50
  investment: 'oklch(51.1% 0.262 276.966)' # indigo-600, savings rate only
typography:
  family: 'Tailwind font-sans (system UI stack); no web font is loaded'
  title:
    fontSize: '1.5rem' # text-2xl
    fontWeight: 600
  section:
    fontSize: '1.125rem' # text-lg
    fontWeight: 600
  body:
    fontSize: '0.875rem' # text-sm, the default for nearly all UI text
    fontWeight: 400
  caption:
    fontSize: '0.75rem' # text-xs
    fontWeight: 500
  figures: 'tabular-nums on every amount column'
rounded:
  table-control: '0.375rem' # rounded-md, inputTableMini only
  card-desktop: '0.5rem' # rounded-lg, cardBase at lg and up
  control: '0.75rem' # rounded-xl, every field and Button
  card-mobile: '1.5rem' # rounded-3xl, cardBase below lg
  pill: '9999px' # rounded-full, chips and badges
spacing:
  target: '2.75rem' # h-11, the 44px field and touch template
motion:
  popover-in: '160ms ease-out'
  popover-out: '120ms ease-in'
  overlay-in: '180ms ease-out'
  overlay-out: '140ms ease-in'
  press-min: '120ms'
  hover: '120ms ease-out, colours only'
components:
  button-primary:
    background: '{colors.ink}'
    color: '{colors.surface}'
    rounded: '{rounded.control}'
  button-danger:
    background: '{colors.negative}'
    color: '{colors.surface}'
    rounded: '{rounded.control}'
  field:
    height: '{spacing.target}'
    border: '{colors.border}'
    rounded: '{rounded.control}'
  card:
    background: '{colors.surface}'
    border: '{colors.border}'
omitted: [Layout]
---

# Design System: BudgetPilot

Recorded from the code on 2026-10-31 by the D0 pass. **The code is the authority**: where this page
and a component disagree, the component wins and this page is corrected. Which file implements each
brick, and what each wave added, is `docs/reference/design-referential.md`; this page does not
restate it.

## 1. Overview

A quiet ledger. Zinc greys carry the whole interface, colour is reserved for what money is doing
(rose out, emerald in, amber for a warning), and a figure is never decorated. Surfaces are flat and
separated by one 1 px border, never by a shadow. The member is here to finish a task, so every
screen leads with the one control that does it.

## 2. Colors

Monochrome zinc plus three semantic hues. Measured on 458 tracked source files on 2026-10-31
(`git ls-files 'src/*.svelte' 'src/*.ts' | xargs grep -ohE '\btext-[a-z]+-[0-9]+\b' | sort | uniq -c`):
zinc accounts for every one of the top five text colours.

**The Money Rule.** Rose and emerald mean the direction of money and nothing else. Never use them
for decoration, branding or a « nice » accent. Chart hues come from `CATEGORY_PALETTE` and
`NATURE_COLORS` in `src/lib/domain/colors.ts`, whose comments tie each hue to its text class.

**No dark theme.** The app ships light only; no `dark:` class exists in the tree.

## 3. Typography

One family, the system UI stack, so the app renders in the member's own operating-system face and
loads no font. `text-sm` is the working size; `text-xs` labels and metadata; `text-lg`, `text-xl`
and `text-2xl` are the heading steps in regular use. Weight carries hierarchy (`font-medium`,
`font-semibold`) more than size does. Amounts use `tabular-nums` so columns align.

## 4. Elevation & Depth

**The Flat Card Rule** (`cardBase`, `src/lib/styles.ts`): a card is a white surface with a 1 px
zinc-200 border and never a shadow. Shadows exist only on what floats above the page: menus,
popovers, tooltips, dialogs.

## 5. Shapes

Radius tracks the size of the thing. Fields and buttons are `rounded-xl` (12 px). Cards are
`rounded-3xl` (24 px) on a phone and `rounded-lg` (8 px) from `lg` up, so a phone card reads as a
sheet and a desktop card as a panel. Chips and badges are pills. Table-row controls are `rounded-md`.

## 6. Components

- **Button** (`src/lib/components/Button.svelte`): primary is zinc-950 with white text, danger
  rose-600, positive for a money-in confirmation; secondary and ghost are neutral. Beside a field it takes `size="field"` so both are exactly 44 px.
- **Field** (`inputBase`): 44 px high, 12 px radius, zinc-200 border, a zinc-400 focus ring. The one
  exception is `inputTableMini`, inside table rows.
- **Pressed state** (`src/lib/press.ts`): held for at least 120 ms so a quick tap is still seen.
- **Motion** (`src/lib/motion.ts`): enter eases out, exit eases in, never a bounce; reduced motion
  sets every duration to exactly 0 s (`src/routes/layout.css`).

## 7. Do's and Don'ts

### Do

- Judge every screen first by how few steps its journey takes (`PRODUCT.md`, principle 1).
- Reuse `inputBase`, `cardBase`, `transitionHover` and `Button` sizes rather than retyping classes.
- Keep a 44 px target on every control a thumb can reach.
- Give every figure `tabular-nums` and its sign colour from the Money Rule.

### Don't

- Add a gradient, a glow, or a shadow on a card at rest.
- Use rose or emerald for anything that is not money direction or an error and success state.
- Set text in zinc-400 on white: it fails WCAG AA text contrast, and the uses already in the tree
  are tracked in #909.
- Add a web font or a second family.
