/**
 * The application's Prisma types, taken from one provider's generated client.
 *
 * There are three generated clients, one per provider, and they are structurally identical by
 * construction: `schemaGenerator.ts` derives all three schemas from `prisma/schema.prisma`,
 * varying only the datasource block, the client's output directory, and native column types.
 * Native column types are a storage detail — `@db.Text` and `@db.VarChar(191)` are both
 * `String` — so the generated TypeScript is the same shape in all three.
 *
 * Every consumer imports its Prisma types from here rather than reaching into
 * `generated/sqlite/` directly, so "which client names the types" is stated once instead of in
 * a dozen files. SQLite is the one named because it is the default provider and the only one
 * whose schema is hand-authored.
 *
 * Types only. Nothing here is a value at runtime, so importing this module pulls no client into
 * a bundle. `client.ts` is what actually constructs one, and it imports all three.
 *
 * Relative, `.ts`-suffixed imports, like the rest of this directory: these types are also used
 * by modules the maintenance scripts under `scripts/` run in plain Node, with no Vite
 * resolution and no `$lib` alias.
 */
import type { Prisma as GeneratedPrisma } from './generated/sqlite/client.ts';

export type { Prisma } from './generated/sqlite/client.ts';

/**
 * The client as every consumer actually receives it, which is NOT the generated one.
 *
 * `createPrismaClient` applies the money-column extension (see moneyColumns.ts), so the eight
 * money columns read as `number` rather than the `bigint` the generated client declares. Naming
 * the generated `PrismaClient` here instead would hand every module that takes a client
 * parameter a type that disagrees with the value it is given, in the direction that reads as
 * `bigint` and behaves as `number`.
 *
 * `typeof import(...)` keeps this type-only: no value is imported and no client reaches a bundle,
 * which is the property the docstring above depends on.
 */
export type PrismaClient = ReturnType<typeof import('./client.ts').createPrismaClient>;
export type {
	BankConnectionStatus,
	NetWorthAccountType,
	Role,
	TransactionNature
} from './generated/sqlite/enums.ts';

/**
 * A transaction row as the EXTENDED client returns it, for the helpers that are generic over a
 * `select`.
 *
 * `Prisma.TransactionGetPayload<{ select }>` is the GENERATED payload and knows nothing about the
 * money-column extension, so a helper typed that way declares `amountCents: bigint` while handing
 * its caller a `number`. That is the aggregate trap inverted: the value is right and the type is
 * wrong, and it propagates to every caller of the helper rather than staying at one call site.
 * `Prisma.Result` resolves against the client's own delegate type, extension included.
 */
export type TransactionPayload<Select> = GeneratedPrisma.Result<
	PrismaClient['transaction'],
	{ select: Select },
	'findFirstOrThrow'
>;
