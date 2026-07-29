/**
 * Shared options for Prisma interactive transactions that can legitimately run long.
 *
 * Prisma's defaults (`maxWait` 2s, `timeout` 5s) are sized for a database sitting right
 * next to the process. They are never reached against the SQLite file the app ships with,
 * where a whole transaction is a handful of microseconds of local I/O. They are reached as
 * soon as the database moves behind a network socket: a full-account restore issues one
 * statement per net worth account, bank connection, account, category and import batch, so
 * a real dataset multiplies the round trip by hundreds and spends the 5s budget before it
 * reaches the bulk inserts.
 *
 * Hitting the timeout is safe (the transaction rolls back, no half-restored account
 * survives) but it makes the feature unusable, and it would only ever show up on a
 * database engine other than the default. So the budget is set deliberately here rather
 * than inherited from a default that happened to fit one provider.
 *
 * Deliberately a constant, not an environment variable: this is an internal safety margin,
 * not something an operator should have to reason about or tune.
 */
export const LONG_TRANSACTION_OPTIONS = {
	/** How long to wait for a connection from the pool before giving up. */
	maxWait: 15_000,
	/** How long the transaction itself may hold that connection. */
	timeout: 120_000
} as const;
