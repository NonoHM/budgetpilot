// Relative, `.ts`-suffixed imports: `client.ts` reaches this, and plain Node runs that for the
// maintenance scripts with no Vite resolution and no `$lib` alias.
import { toMinorUnits } from './minorUnits.ts';

/**
 * The seam where the eight 64-bit money columns become the `number` the rest of the codebase uses.
 *
 * ## Why this exists at all
 *
 * The money columns are `BigInt` so the app's own net-worth cap fits at exponent 3 and 4. Prisma
 * reads a `BigInt` scalar as a JavaScript `bigint` and there is no schema-level escape: MEASURED,
 * `Int @db.BigInt` is refused on all three connectors. A `bigint` in the domain would break
 * `JSON.stringify` (the backup export), `bigint + number` (every aggregate) and `Math.abs`
 * (`import/persist.ts`), and would buy nothing: see minorUnits.ts for why a `number` is already
 * exact for every amount this application allows.
 *
 * So one `result` extension, applied in `createPrismaClient`, which is the only place a client is
 * built. VERIFIED rather than asserted: zero `new *PrismaClient(` outside that switch and zero
 * imports of a generated client anywhere else in the tree, so nothing else can build one.
 *
 * ## What this extension does NOT cover, which is the part worth knowing
 *
 * **`aggregate` and `groupBy`.** MEASURED both ways on one schema: `_sum` typechecks as
 * `number | null` under this extension and returns a `bigint` at run time. Prisma derives the
 * aggregate's TYPE from the extended payload and does not route its VALUE through the extension,
 * so the compile-time answer is the one that is wrong and `npm run check` reports clean over sites
 * that throw. Every such site wraps its read in `toMinorUnits`, and moneyColumns.spec.ts asserts
 * that by reading the sources, because the typechecker is the thing that is wrong and therefore
 * cannot be the detector.
 *
 * **`$queryRaw`.** MEASURED: a raw select of one of these columns returns a `bigint`, and the row
 * typechecks as whatever the caller declares, so there is no compile-time signal at all. There is
 * no such query today and moneyColumns.spec.ts pins the absence.
 *
 * **What it does cover, measured rather than hoped**: `findMany`, a narrow `select` of only the
 * money field, and an interactive `$transaction` callback's `tx`.
 *
 * ## Why the block below is written out and not built from a list
 *
 * A loop over a map of column names produces the same run-time behaviour and loses the types:
 * `$extends` retypes the read only when it can see the literal. An extension that narrows at run
 * time while every read still typechecks as `bigint` is the aggregate trap inverted, and worse,
 * because it would be everywhere instead of in five places. The literal is kept honest by
 * moneyColumns.spec.ts, which reads `prisma/schema.prisma` and requires the two to agree.
 */
export const moneyColumnsExtension = {
	name: 'money-columns-as-numbers',
	result: {
		transaction: {
			amountCents: {
				needs: { amountCents: true },
				compute: (row: { amountCents: bigint }) =>
					toMinorUnits(row.amountCents, 'Transaction.amountCents')
			}
		},
		transactionSplit: {
			amountCents: {
				needs: { amountCents: true },
				compute: (row: { amountCents: bigint }) =>
					toMinorUnits(row.amountCents, 'TransactionSplit.amountCents')
			}
		},
		monthlyBudget: {
			amountCents: {
				needs: { amountCents: true },
				compute: (row: { amountCents: bigint }) =>
					toMinorUnits(row.amountCents, 'MonthlyBudget.amountCents')
			}
		},
		netWorthAccount: {
			balanceCents: {
				needs: { balanceCents: true },
				compute: (row: { balanceCents: bigint }) =>
					toMinorUnits(row.balanceCents, 'NetWorthAccount.balanceCents')
			}
		},
		netWorthSnapshot: {
			balanceCents: {
				needs: { balanceCents: true },
				compute: (row: { balanceCents: bigint }) =>
					toMinorUnits(row.balanceCents, 'NetWorthSnapshot.balanceCents')
			}
		},
		savingsGoal: {
			targetAmountCents: {
				needs: { targetAmountCents: true },
				compute: (row: { targetAmountCents: bigint }) =>
					toMinorUnits(row.targetAmountCents, 'SavingsGoal.targetAmountCents')
			},
			currentAmountCents: {
				needs: { currentAmountCents: true },
				compute: (row: { currentAmountCents: bigint }) =>
					toMinorUnits(row.currentAmountCents, 'SavingsGoal.currentAmountCents')
			},
			startingBalanceCents: {
				needs: { startingBalanceCents: true },
				compute: (row: { startingBalanceCents: bigint }) =>
					toMinorUnits(row.startingBalanceCents, 'SavingsGoal.startingBalanceCents')
			}
		}
	}
} as const;
