/**
 * The closed role set, in the ONE place both the server and the browser can import it from.
 *
 * It used to live in `$lib/server/import/mapping/model.ts`, which is correct for everything else in
 * that file and wrong for this: the roles are not a secret, they are the vocabulary the designation
 * screen is built out of. SvelteKit refuses a `$lib/server` import from browser code, and it is
 * right to, so the choice was between moving the set here and restating it client side.
 *
 * **Restating it was the option to refuse.** A second literal union agreeing with the first is the
 * two-predicates shape this repository has been caught by more than once: the closure is what makes
 * the role set a schema property rather than a validation rule (ASVS V2.2.1), and a closed set
 * declared twice is not closed, it is two sets that happen to match today.
 *
 * `model.ts` re-exports both names, so every existing server import keeps working and there is
 * still exactly one definition.
 *
 * **Caught by `npm run build`, by neither `npm run check` nor `vitest`.** The typecheck resolves
 * the import happily and vitest transpiles without the guard, so the first thing that could see it
 * was the client bundle. That is the lower-bound rule in `CLAUDE.md` arriving from a new direction:
 * a worklist built from the typecheck alone misses whatever only the bundler enforces.
 */

/**
 * Four, by specification.
 *
 * Order matters and is load bearing twice: it is the order roles are reported in, and the design
 * requires a missing-roles sentence to name them in ROW order rather than as a count.
 */
export const MAPPING_ROLES = ['date', 'label', 'amount', 'category'] as const;

export type MappingRole = (typeof MAPPING_ROLES)[number];

/** The three a transaction cannot be built without. `category` is the optional fourth. */
export const REQUIRED_MAPPING_ROLES = [
	'date',
	'label',
	'amount'
] as const satisfies readonly MappingRole[];
