# Design referential: where each brick lives in this repository

**The referential itself is not tracked here.** It is a Design project deliverable
(`Référentiel Composants BudgetPilot`, plus `Référentiel V2 Additions`), and the screen plates that
consume it are deliverables too. This page is the durable half: for every brick, the file in this
repository that implements it, and for every entry a wave ADDS to the referential, where that entry
was written down.

**Why it exists.** A registration nobody can reach registers nothing. Before this page, a wave that
added a brick recorded it in a pull request body, which stops being consulted the moment it merges,
and in a component docstring, which is only found by someone who already knew the component existed.
The next screen needing a pressed state had no way to discover that one had been decided. Same
problem and same shape as [ASVS deltas](./asvs-deltas.md), and the same answer.

**How it is written.** One row per brick. The "In this repository" column is the authority for
behaviour; the plate is the authority for intent. When they disagree, the disagreement is a finding
and gets recorded in the row rather than silently resolved. Additions go in the second table with
the wave that made them.

---

## The sixteen bricks, and the V2 additions

| Brick         | What it is                                                   | In this repository                                                                |
| ------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1             | IconButton, single size, tones neutral / danger, toggle role | `src/lib/components/ui/IconButton.svelte`                                         |
| 2             | Badge, tone / shape / bordered                               | `src/lib/components/ui/Badge.svelte`                                              |
| 3             | ListCard, one padding, one border rule                       | `src/lib/components/ui/ListCard.svelte`, `cardBase` in `src/lib/styles.ts`        |
| 4             | TapLink, no permanent underline                              | `src/lib/components/ui/TapLink.svelte`                                            |
| 5             | Card radius and border rule                                  | `cardBase` in `src/lib/styles.ts`                                                 |
| 6             | MoneyInput, 44 px, inline euro suffix                        | `src/lib/components/ui/MoneyInput.svelte`, `inputBase` in `src/lib/styles.ts`     |
| 7             | EmptyState, solid-card family                                | `src/lib/components/ui/EmptyState.svelte`                                         |
| 8             | Post-action feedback: AlertBanner, never a toast             | `src/lib/components/AlertBanner.svelte`                                           |
| 9             | Loading: Skeleton, button Spinner, page Spinner              | `src/lib/components/ui/Skeleton.svelte`, `Spinner.svelte`, `PageSpinner.svelte`   |
| 10            | Dropdown / Select                                            | `src/lib/components/ui/Select.svelte`, `FilterDropdown.svelte`, `Combobox.svelte` |
| 11            | Tooltip                                                      | `src/lib/components/ui/Tooltip.svelte`                                            |
| 12            | Micro-interactions, one set of durations and easings         | `src/lib/motion.ts`, `transitionHover` in `src/lib/styles.ts`                     |
| 13            | Avatar                                                       | `src/lib/components/Avatar.svelte`                                                |
| 14            | SearchBar                                                    | `src/lib/components/ui/SearchBar.svelte`                                          |
| 15            | Modal, standard and destructive confirmation                 | `src/lib/components/Modal.svelte`, `ConfirmDialog.svelte`                         |
| 16            | Navigation, desktop topbar and mobile bottom bar             | `src/lib/components/AppNav.svelte`, `AppHeader.svelte`                            |
| V2 new brick  | Calendar cell, eleven states, two sizes                      | `src/lib/components/ui/RangeCalendar.svelte`, `src/lib/domain/rangeCalendar.ts`   |
| V2 new rule   | Sheet footer: the primary never scrolls                      | `src/lib/components/BottomSheet.svelte`, prose in `src/lib/styles.ts`             |
| V2 precedence | The 44 px floor beats any smaller desktop value              | prose in `src/lib/styles.ts`                                                      |

The button atom is marked "existing, out of scope" in the referential and has no brick of its own.
It is `src/lib/components/Button.svelte`. Its bordered secondary variant is a gap, see below.

## Additions made by waves in this repository

| Added              | Entry                                                                                                                                                                                                                                                                                  | Where it is written down                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave 5, Planche 5a | **The pressed state**, for eight tones, with its timing rule (no transition in, 120 ms ease-out out, 120 ms minimum display) and its three clauses (never survives pointerup, pointercancel skips the floor, no `aria-*` carries it)                                                   | Rule and clauses: `src/lib/press.ts`. Tints and class tokens: the "Planche 5a" block in `src/lib/styles.ts`. Clauses asserted separately in `src/lib/press.svelte.spec.ts`. |
| Wave 5, Planche 5g | **rose-800 `#9f1239`**, the plate's only new tint. White on it 7.6:1, it on white 6.8:1. Used by the filled-rose press and the TapLink danger press.                                                                                                                                   | `pressFilledRose` and `pressUnderlineDanger` in `src/lib/styles.ts`                                                                                                         |
| Wave 5, Planche 5g | **`press-inset`**, `inset 0 2px 6px rgba(0,0,0,.35)`. A fill presses by sinking rather than by scaling, so it survives `prefers-reduced-motion`.                                                                                                                                       | `pressFilled` in `src/lib/styles.ts`                                                                                                                                        |
| Wave 5, Planche 5d | **Brick 6c, SwitchRow**: a 48 px row that IS the switch, label plus value in words, consequence linked by `aria-describedby`, `lockedReason` that renders inert and states its reason. Closes the "two-option segmented control" gap the Colonnes plate flagged and refused to invent. | `src/lib/components/ui/SwitchRow.svelte`                                                                                                                                    |

## Gaps named by a plate and not filled

Named rather than closed in silence. Each is filed, and the issue is where the argument continues.

| Gap                | What the referential does not say                                                                                                  | State                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Bordered button    | The button atom is "existing, out of scope", so its secondary bordered variant is specified nowhere, and Planche 5b's R1 needs one | Filed. Nothing is drawn outside that plate while it is open.                                |
| Busy button        | Brick 9 defines the button spinner but not the occupancy contract: no `aria-busy`, no width freeze, no ban on native `disabled`    | Filed. To register as a clause of brick 9, not as a component.                              |
| TapLink affordance | The clause is contextual, and the same section removes the context. An internal contradiction, not an implementation error         | Filed. R1 to ship, R3 (make the clause positional) to repair.                               |
| Skeleton placement | Brick 9 says "past 300 ms" without saying which screen can show one, which is how one came to be built where it is impossible      | Filed. To register: a skeleton exists only where the structure is known before the content. |
