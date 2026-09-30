# How the code is written

AGENTS.md « Security boundaries », « Code style » and « Writing a sentence for the interface » are the
rules. This is the owner's standing demand stated as checks: secure by design, centralised,
maintainable, future-proof.

## Secure coding

- The standards the PR satisfies are named in the PR body by full identifier with their text quoted,
  resolved from the local copy first: the `cite` skill.
- Untrusted cell content that reaches the page is bounded (`refusalCellValue`).
- No banking data, token or raw imported metadata in a log, an error page or a test fixture.
- A PR that adds or changes a gate (hook, permission rule, CI job, a spec that scans the tree): the
  personal `guardrails` skill where installed; this repository's gates are
  `docs/explanation/confidentiality-guards.md` and the milestone « Gates that do not gate ».

## Centralised: one definition per rule

- A condition used by two callers is one function both call. Never retype a predicate, never copy a
  constant into a test: a copy passes with its original and fails apart from it, so a test over
  either cannot say which one the application consulted.
- A test that covers "every X" enumerates X from the registry (the union type, the profiles list, the
  callers), so a new member cannot be added unclassified.

## Future-proof and maintainable

- Make an illegal state unrepresentable: a type, not a convention.
- A value that can be derived is not stored.
- No abstraction for a single caller.
- Maintainability is a first criterion (ISO/IEC 25010: modularity, reusability, analysability,
  modifiability, testability; source in the `cite` skill's reference list).
- Before writing a component, look in `src/lib/components/ui/` and
  `docs/reference/design-referential.md`; reuse or register, never inline a copy.

## Strings and screens

- Any change to what renders: `.claude/rules/ui.md` fires when a `.svelte` file is read and carries
  the UI path (design skills, the canvas, the strings).
- Any docs page: `.claude/rules/docs.md` fires on the four documentation trees.
