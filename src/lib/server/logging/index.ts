import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import type { Handle } from '@sveltejs/kit';
import { createLogWriter, stdoutSink, type LogWriter, type RequestFields } from './core.ts';
import { loggableError } from '$lib/server/errors';
import type { ErrorFields, LogEvent } from './events.ts';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import {
	DEFAULT_LOG_LEVEL,
	readLogSettings,
	resolveLogLevel,
	resolveSecurityLog
} from './settings.ts';

/**
 * The application's log. `log(event)` is the only way to write a line, and `LogEvent` is the only
 * shape a line can take (`events.ts`). In `src/lib/server`, `src/routes`, `src/hooks.server.ts` and
 * `boot.mjs`, ESLint refuses every other way out that a rule can see (`eslint.config.js`): any
 * reference to `console`, including through `globalThis`, a write to file descriptor 1 or 2, stdout
 * or stderr from the process object or from `node:process`, and the writer's core imported
 * directly. A dependency that writes to `process.stdout` itself is outside any lint rule: the console
 * bridge below does not see it either, and the injection probe is what would.
 */
export type { LogEvent };

interface RequestContext extends RequestFields {
	/** The same id as `traceId`, in the dashed form the error page shows the visitor. */
	errorId: string;
}

const requests = new AsyncLocalStorage<RequestContext>();

/** OpenTelemetry's rule for `http.request.method`: a known method as sent, anything else `_OTHER`. */
const KNOWN_METHODS = new Set([
	'CONNECT',
	'DELETE',
	'GET',
	'HEAD',
	'OPTIONS',
	'PATCH',
	'POST',
	'PUT',
	'QUERY',
	'TRACE'
]);

let writer: LogWriter | undefined;

function current(): LogWriter {
	writer ??= createLogWriter({
		...readLogSettings(process.env),
		sink: stdoutSink(),
		context: () => requests.getStore()
	});
	return writer;
}

export function log(event: LogEvent): void {
	current()(event);
}

/** The boot backfill lock's wait report (database/advisoryLock.ts, `onWait`). */
export function logBackfillLockWait(name: string, waitedSeconds: number): void {
	log({
		event: E.backfillLockWait,
		attributes: { [A.backfillName]: name, [A.backfillWaitedSeconds]: waitedSeconds }
	});
}

/**
 * A caught error as log attributes: `loggableError`'s class name, code and operator message, and
 * nothing else. The one rule for what an error may say to the log stays in server/errors.ts
 * (#816); this never reads `message`, `stack` or a nested property itself.
 */
export function errorFields(caught: unknown): ErrorFields {
	const { name, code, message } = loggableError(caught);
	return {
		[A.errorType]: name,
		...(code === undefined ? {} : { [A.errorCode]: code }),
		...(message === undefined ? {} : { [A.errorOperatorMessage]: message })
	};
}

/**
 * Entered first in `hooks.server.ts`, before `handleAuth`, so every line written while a request is
 * handled carries its id, method and route. The id is ALWAYS generated here: an inbound
 * `X-Request-Id` is never read, because a trusted proxy forwards what it was sent and a pattern
 * that admits an id also admits an IBAN (#250, correction of 2026-10-01). The route is the matched
 * route TEMPLATE (`/imports/[batchId]`), never the path, so no character a visitor typed reaches
 * the line.
 */
export const handleLogContext: Handle = ({ event, resolve }) => {
	const errorId = randomUUID();
	const method = event.request.method.toUpperCase();
	return requests.run(
		{
			errorId,
			traceId: errorId.replaceAll('-', ''),
			method: KNOWN_METHODS.has(method) ? method : '_OTHER',
			route: event.route.id
		},
		() => resolve(event)
	);
};

/** The id of the request being handled, as the error page shows it, when there is one. */
export function requestErrorId(): string | undefined {
	return requests.getStore()?.errorId;
}

/**
 * Routes whatever a DEPENDENCY prints to the console through the writer, as
 * `budgetpilot.console.output`, so stdout stays one JSON object per line: adapter-node's « Listening
 * on » line is the measured instance. Built server only; in dev Vite owns the console. Our own code
 * cannot reach it, because the lint rule forbids it `console`. It wraps the methods that print,
 * `dir` included; it does not see a dependency writing to `process.stdout` or `process.stderr`
 * directly, which no wrapper of the console can.
 */
export function installConsoleBridge(
	// eslint-disable-next-line no-restricted-globals -- the bridge is the one place that must hold the console
	target: Console = console,
	write: (event: LogEvent) => void = log
): void {
	let writing = false;
	for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'] as const) {
		target[method] = (...args: unknown[]) => {
			if (writing) return;
			writing = true;
			try {
				write({
					event: E.consoleOutput,
					attributes: { [A.consoleMethod]: method, [A.consoleText]: format(...args) }
				});
			} finally {
				writing = false;
			}
		};
	}
}

/**
 * Boot check for the two settings, registered in `env/assertConfigured.ts`: refuses a value outside
 * the domain, and writes the departure from each default.
 */
export function assertLoggingConfigured(
	env: Record<string, string | undefined> = process.env
): void {
	const level = resolveLogLevel(env);
	const securityLog = resolveSecurityLog(env);
	if (level !== DEFAULT_LOG_LEVEL) {
		log({ event: E.configLogLevelChanged, attributes: { [A.configLogLevel]: level } });
	}
	if (securityLog === 'off') {
		log({ event: E.sysMonitorDisabled, attributes: { [A.monitor]: 'security_log' } });
	}
}
