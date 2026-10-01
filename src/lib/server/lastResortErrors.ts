import { describeErrorForLog } from './errors';

/** The part of `process` this needs, so a spec can hand it a fake one that does not exit. */
export interface ProcessLike {
	on(event: 'uncaughtException', listener: (caught: unknown, origin: string) => void): unknown;
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
	exit(code: number): unknown;
	stderr: { write(text: string): unknown };
}

/**
 * The printer of last resort, replacing Node's own (#816).
 *
 * Node's default writes an uncaught error with `util.inspect`, which walks every nested property:
 * measured on the built server, a failing boot recompute put a user's transaction label in the log
 * through `meta.driverAdapterError.cause.originalMessage`. `init` failing reaches here because
 * SvelteKit rethrows it outside dev and adapter-node awaits `server.init` at the top level, which
 * Node routes to `uncaughtException` with origin `unhandledRejection` (measured on Node 24). An
 * ordinary unhandled rejection arrives at the second listener.
 *
 * Exits 1, as Node's default does for both, so a container restart policy sees the same failure it
 * always did. Writes to stderr directly rather than through `console`, which is synchronous for a
 * file or a pipe on Linux and so is written before the exit.
 */
export function installLastResortErrorHandlers(proc: ProcessLike = process): void {
	const report = (caught: unknown, origin: string) => {
		proc.stderr.write(`[budgetpilot] fatal ${origin}: ${describeErrorForLog(caught)}\n`);
		proc.exit(1);
	};
	proc.on('uncaughtException', report);
	proc.on('unhandledRejection', (reason) => report(reason, 'unhandledRejection'));
}
