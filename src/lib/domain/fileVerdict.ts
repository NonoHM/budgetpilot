/**
 * What a per-file decision can conclude, when the decision has exactly this shape: the file may
 * PROVE one answer, PROVE two answers that contradict each other, EXHIBIT the ambiguity without
 * proving anything, or carry no evidence at all.
 *
 * ## Why this registers now, and did not ten days ago
 *
 * `import/dateOrder.ts`'s `DateOrderVerdict` was the only inhabitant of this shape until #485 gave
 * `import/discriminant.ts`'s `DiscriminantResult` the same four states (`basis: 'iban'` proves a
 * contradiction, `basis: 'digit-run'` only exhibits one). AGENTS.md's own rule against a shared
 * generic — "collapsing them would merge refusing with asking" — is about the OUTCOME a caller
 * takes, never about this taxonomy: refusing and asking are two different `decide*` functions
 * consuming this type, not two states inside it. One inhabitant is a coincidence; a second
 * genuinely wanting the same four states, independently, is the pattern the rule is about
 * registering.
 *
 * ## Generic over the PAYLOAD, not over the KIND
 *
 * The four states are shared verbatim (`resolved` reads the same both times: the file proved one
 * answer). What each state carries is not, and forcing that to match would be the dishonest half
 * of a shared type: `dateOrder.ts`'s `contradictory` needs BOTH conflicting cells shown, because
 * neither reading is wrong alone; `discriminant.ts`'s `contradictory` needs only the column index,
 * because a verified checksum collision needs no second cell to make its case. Three type
 * parameters, one per non-empty state, is what keeps that honest: `nothing-to-decide` is the one
 * state with nothing to parameterise, in both instances, which is itself evidence this is one
 * shape and not two similar ones.
 */
export type FileVerdict<Resolved, Contradiction, Ambiguous> =
	| ({ kind: 'resolved' } & Resolved)
	| ({ kind: 'contradictory' } & Contradiction)
	| ({ kind: 'ambiguous' } & Ambiguous)
	| { kind: 'nothing-to-decide' };
