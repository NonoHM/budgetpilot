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
export type { Prisma, PrismaClient } from './generated/sqlite/client.ts';
export type {
	BankConnectionStatus,
	NetWorthAccountType,
	Role,
	TransactionNature
} from './generated/sqlite/enums.ts';
