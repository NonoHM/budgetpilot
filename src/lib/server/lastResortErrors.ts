import { describeErrorForLog } from './errors';

/** The part of `process` this needs, so a spec can hand it a fake one that does not exit. */
export interface ProcessLike {
	on(event: 'uncaughtException', listener: (caught: unknown, origin: string) => void): unknown;
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
	exit(code: number): unknown;
	stderr: { write(text: string): unknown };
}

/**
 * The printer of last resort, replacing Node's own once `hooks.server.ts` has loaded (#816). An
 * error thrown while modules are still being evaluated, before that, still reaches Node's printer;
 * what runs then is configuration parsing (`db.ts`, `database/client.ts`), and no query.
 *
 * Node's default writes an uncaught error with `util.inspect`, which walks every nested property:
 * measured on the built server, a failing boot recompute put a user's transaction label in the log
 * through `meta.driverAdapterError.cause.originalMessage`. `init` failing reaches here because
 * SvelteKit rethrows it outside dev and adapter-node awaits `server.init` at the top level, which
 * Node routes to `uncaughtException` with origin `unhandledRejection` (measured on Node 24). An
 * ordinary unhandled rejection arrives at the second listener.
 *
 * Exits 1, as Node's default does for both, so a container restart policy sees the same failure it
 * always did. Writes with `process.stderr.write`, which is synchronous for a file or a pipe on
 * Linux, so the line is out before the exit.
 */
export function installLastResortErrorHandlers(proc: ProcessLike = process): void {
	const report = (caught: unknown, origin: string) => {
		proc.stderr.write(`[budgetpilot] fatal ${origin}: ${describeErrorForLog(caught)}\n`);
		proc.exit(1);
	};
	proc.on('uncaughtException', report);
	proc.on('unhandledRejection', (reason) => report(reason, 'unhandledRejection'));
}
