/**
 * The shape a collision warning is drawn from, on both sides of the network.
 *
 * Here rather than beside the rule in `server/import/collision.ts` because a Svelte component may
 * not import from `$lib/server`: the alias is what keeps database code out of the client bundle,
 * and a type-only import is not an exception the bundler can see through reliably. `src/lib/domain`
 * is the project's answer to that, pure logic with no `$lib/server`, no `$app/*` and no Prisma.
 *
 * Money is in cents and dates are ISO. Nothing here is formatted: a localised string does not
 * travel through a payload, it is produced by the page that knows the locale.
 */

/** One batch, described in the three figures the collision rule compares. */
export interface CollisionFigures {
	/** Nullable, like `ImportBatch.fileName` itself. The page substitutes its own default. */
	fileName: string | null;
	/** ISO date (YYYY-MM-DD), or null when the batch has no dated row. */
	periodStart: string | null;
	periodEnd: string | null;
	transactionCount: number;
	debitCents: number;
	creditCents: number;
}

/** An already-imported batch an incoming run appears to repeat. */
export interface CollidingBatchView extends CollisionFigures {
	batchId: string;
	/** ISO instant the batch was created. */
	createdAt: string;
}
