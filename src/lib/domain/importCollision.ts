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

/**
 * What this run intends to do with the import it is correcting, when it is correcting one.
 *
 * THREE VALUES RATHER THAN A BOOLEAN, and that is the whole reason this type exists. The run
 * carries the batch id whether or not the user left the control ticked, so a flag meaning "is this
 * a correction" would tell the reader the old import is being replaced on a run that is going to
 * delete nothing. The value is derived from the POSTED CHOICE, never from the presence of a
 * correction.
 *
 * The fourth case is that no dialog is drawn at all: on the ordinary ticked correction the guard
 * does not fire, because `findCollidingBatch` excludes the batch being replaced. That case is the
 * wave's whole win and it has no value here because it has no dialog.
 */
export type CorrectionContext = 'none' | 'replacing' | 'keeping';
