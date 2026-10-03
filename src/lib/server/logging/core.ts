import { createHash, randomUUID } from 'node:crypto';
import pino from 'pino';
import { REGISTRY, type LogEvent } from './events.ts';
import { createFloodGate } from './flood.ts';
import {
	ATTRIBUTE as A,
	EVENT as E,
	FIELD,
	SCHEMA_VERSION,
	SERVICE_NAME,
	type EventName
} from './names.ts';
import { capAttributes, escapeLine, MAX_LINE_BYTES } from './serialize.ts';
import type { LogLevelSetting, SecurityLogSetting } from './settings.ts';

/**
 * The writer: one typed event in, one line of flat NDJSON out (#250).
 *
 * THE LINE. OpenTelemetry Logs Data Model field names for the envelope (`timestamp` in UTC ISO 8601,
 * `severity_text` and `severity_number` on OpenTelemetry's 1 to 24 scale, never pino's 10 to 60,
 * `event_name`, `body`, and `trace_id` inside a request), then the event's attributes as flat
 * scalar keys, then four integrity fields: the schema version, a random id for this process, a
 * sequence number, and the SHA-256 of the previous line as written. Pino does the level filtering
 * and the encoding; it has no transport and writes synchronously to file descriptor 1.
 *
 * WHAT THE CHAIN IS FOR, AND WHAT IT IS NOT. A gap in `budgetpilot.log.seq` or a `budgetpilot.log.prev`
 * that does not match the hash of the line before it shows that a line was removed or edited after
 * it was written. It does not stop anyone holding the host from rewriting the whole file and the
 * chain with it: the tamper-evident logging literature assumes a verifier the attacker cannot
 * reach, and on one host that is a log shipped off it (#250, comment of 2026-10-01).
 *
 * WHAT IS SHARED. `boot.mjs` imports this file as TypeScript source and the server imports the
 * bundled copy, so two module instances write in one process. The chain state lives on a global
 * symbol so that the server's first line continues the sequence `boot.mjs` started rather than
 * restarting it.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

type PinoMethod = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const METHOD_OF = {
	DEBUG: 'debug',
	INFO: 'info',
	WARN: 'warn',
	ERROR: 'error',
	FATAL: 'fatal'
} as const;

/** OpenTelemetry's SeverityText and the first SeverityNumber of each range. */
const OTEL_SEVERITY: Record<PinoMethod, [string, number]> = {
	debug: ['DEBUG', 5],
	info: ['INFO', 9],
	warn: ['WARN', 13],
	error: ['ERROR', 17],
	fatal: ['FATAL', 21]
};

const ZERO_HASH = '0'.repeat(64);
const LONG_KEYS: ReadonlySet<string> = new Set([A.errorOperatorMessage]);
/** What `budgetpilot.log.line_too_long` keeps of a line it replaces: the envelope, no attribute. */
const ENVELOPE_KEYS = [
	FIELD.severityText,
	FIELD.severityNumber,
	FIELD.timestamp,
	FIELD.traceId,
	A.httpMethod,
	A.httpRoute,
	A.serviceName,
	A.logSchema,
	A.logBootId,
	A.logSeq,
	A.logPrev
];

export interface ChainState {
	bootId: string;
	seq: number;
	prev: string;
}

const CHAIN = Symbol.for('budgetpilot.log.chain');

/** The chain of this process, created on first use and shared by every writer in it. */
export function processChain(): ChainState {
	const holder = globalThis as { [CHAIN]?: ChainState };
	holder[CHAIN] ??= { bootId: randomUUID(), seq: 0, prev: ZERO_HASH };
	return holder[CHAIN];
}

export function newChain(): ChainState {
	return { bootId: randomUUID(), seq: 0, prev: ZERO_HASH };
}

/** What a request contributes to every line written while it is handled. */
export interface RequestFields {
	traceId: string;
	method: string;
	route: string | null;
}

export interface WriterOptions {
	level: LogLevelSetting;
	securityLog: SecurityLogSetting;
	/** Receives each finished line, newline included. */
	sink: (line: string) => void;
	chain?: ChainState;
	context?: () => RequestFields | undefined;
	now?: () => number;
	schedule?: (run: () => void, ms: number) => void;
}

export type LogWriter = (event: LogEvent) => void;

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What a flood window counts, kept for its summary line. Every field is bounded by the code. */
interface FloodLabel {
	event: EventName;
	status?: number;
	route?: string;
	errorType?: string;
}

/**
 * The flood window an event falls in: its name, and the status, the route template and the error
 * class where it has them. All four are bounded (a closed set of events, of statuses, of routes in
 * the code, and of classes the code throws), so the number of windows is too. Without the route
 * and the class, one repeated failure an anonymous visitor can cause at will filled the window of
 * every other failure with the same status (contradiction pass on L2).
 */
function floodLabel(event: LogEvent, request: RequestFields | undefined): FloodLabel {
	const attributes = event.attributes as Record<string, unknown>;
	const status = attributes[A.httpStatus];
	const errorType = attributes[A.errorType];
	return {
		event: event.event,
		...(typeof status === 'number' ? { status } : {}),
		...(request?.route ? { route: request.route } : {}),
		...(typeof errorType === 'string' ? { errorType } : {})
	};
}

const floodKey = (label: FloodLabel): string =>
	JSON.stringify([label.event, label.status, label.route, label.errorType]);

export function createLogWriter(options: WriterOptions): LogWriter {
	const chain = options.chain ?? processChain();
	const now = options.now ?? Date.now;

	const finish = (line: string): string => {
		const body = line.endsWith('\n') ? line.slice(0, -1) : line;
		const escaped = escapeLine(body);
		const bytes = Buffer.byteLength(escaped, 'utf8');
		if (bytes <= MAX_LINE_BYTES) return escaped;
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const kept: Record<string, unknown> = {};
		for (const key of ENVELOPE_KEYS) if (key in parsed) kept[key] = parsed[key];
		return escapeLine(
			JSON.stringify({
				...kept,
				[FIELD.eventName]: E.logLineTooLong,
				[A.suppressedEvent]: parsed[FIELD.eventName],
				[A.droppedBytes]: bytes,
				[FIELD.body]: REGISTRY[E.logLineTooLong].body
			})
		);
	};

	const logger = pino(
		{
			level: options.level,
			base: null,
			messageKey: FIELD.body,
			timestamp: () => `,"${FIELD.timestamp}":"${new Date(now()).toISOString()}"`,
			formatters: {
				level: (label) => {
					const [text, number] = OTEL_SEVERITY[label as PinoMethod] ?? ['INFO', 9];
					return { [FIELD.severityText]: text, [FIELD.severityNumber]: number };
				}
			}
		},
		{
			write(line: string) {
				const finished = finish(line);
				chain.prev = sha256Hex(finished);
				options.sink(`${finished}\n`);
			}
		}
	);

	const emit = (
		name: EventName,
		method: PinoMethod,
		body: string,
		attributes: object,
		request: RequestFields | undefined
	) => {
		const record = {
			[FIELD.eventName]: name,
			...(request
				? {
						[FIELD.traceId]: request.traceId,
						[A.httpMethod]: request.method,
						...(request.route ? { [A.httpRoute]: request.route } : {})
					}
				: {}),
			[A.serviceName]: SERVICE_NAME,
			...capAttributes(attributes, LONG_KEYS),
			[A.logSchema]: SCHEMA_VERSION,
			[A.logBootId]: chain.bootId,
			[A.logSeq]: (chain.seq += 1),
			[A.logPrev]: chain.prev
		};
		logger[method](record, body);
	};

	const admit = createFloodGate(
		(label: FloodLabel, suppressed, windowSeconds) => {
			// No request context, ever: the timer that closes the window runs inside whichever request
			// scheduled it (AsyncLocalStorage follows setTimeout), and that request is not this line's.
			emit(
				E.logSuppressed,
				'warn',
				REGISTRY[E.logSuppressed].body,
				{
					[A.suppressedEvent]: label.event,
					...(label.status === undefined ? {} : { [A.suppressedStatus]: label.status }),
					...(label.route === undefined ? {} : { [A.suppressedRoute]: label.route }),
					...(label.errorType === undefined ? {} : { [A.suppressedErrorType]: label.errorType }),
					[A.suppressedCount]: suppressed,
					[A.suppressedWindowSeconds]: windowSeconds
				},
				undefined
			);
		},
		{
			now,
			schedule:
				options.schedule ??
				((run, ms) => {
					setTimeout(run, ms).unref();
				})
		}
	);

	return (event) => {
		const spec = REGISTRY[event.event];
		if (spec.security && options.securityLog === 'off') return;
		const method = METHOD_OF[spec.severity];
		if (!logger.isLevelEnabled(method)) return;
		const request = options.context?.();
		if (spec.flood) {
			const label = floodLabel(event, request);
			if (!admit(floodKey(label), label)) return;
		}
		emit(event.event, method, spec.body, event.attributes, request);
	};
}

/** A synchronous sink on file descriptor 1, so a line is out before a `process.exit` that follows. */
export function stdoutSink(): (line: string) => void {
	const destination = pino.destination({ dest: 1, sync: true });
	return (line) => {
		destination.write(line);
	};
}
