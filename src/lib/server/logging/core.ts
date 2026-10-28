import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
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
import { createMerkleTree, type MerkleTree } from './seal/merkle.ts';
import { signCheckpoint } from './seal/note.ts';
import {
	hostTag,
	openSealKey,
	readLinkedCheckpoint,
	SEAL_KEY_NAME,
	writeLinkedCheckpoint,
	type SealKey,
	type SealUnavailable
} from './seal/sealer.ts';
import {
	capAttributes,
	escapeLine,
	MAX_CHECKPOINT_NOTE_LENGTH,
	MAX_LINE_BYTES,
	MAX_OPERATOR_MESSAGE_LENGTH
} from './serialize.ts';
import type { LogLevelSetting, LogSealSetting, SecurityLogSetting } from './settings.ts';

/**
 * The writer: one typed event in, one line of flat NDJSON out (#250).
 *
 * THE LINE. OpenTelemetry Logs Data Model field names for the envelope (`timestamp` in UTC ISO 8601,
 * `severity_text` and `severity_number` on OpenTelemetry's 1 to 24 scale, never pino's 10 to 60,
 * `event_name`, `body`, and `trace_id` inside a request), then the event's attributes as flat
 * scalar keys, then four integrity fields: the schema version, a random id for this process, a
 * sequence number, and the SHA-256 of the previous line as written. The writer filters levels
 * itself, so the seal's lines are written whatever `BP_LOG_LEVEL` says; pino does the encoding, has
 * no transport and writes synchronously to file descriptor 1.
 *
 * THE SEAL (#875, `BP_LOG_SEAL=on`). Each line written after `startSeal` is also a leaf of an
 * RFC 6962 tree, one tree per SEGMENT: from the `seal_started` line, or from a checkpoint line, up
 * to the next checkpoint. A checkpoint is a C2SP signed note over the segment's size and root,
 * written at the interval when lines were written since the last one, and on every `flush()` and
 * process stop. With sealing off no tree exists and no line is hashed beyond the chain.
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

/** pino's order, for the writer's own filter. */
const LEVEL_RANK: Record<PinoMethod, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

const ZERO_HASH = '0'.repeat(64);
const LONG_KEYS: ReadonlyMap<string, number> = new Map([
	[A.errorOperatorMessage, MAX_OPERATOR_MESSAGE_LENGTH],
	[A.logCheckpointNote, MAX_CHECKPOINT_NOTE_LENGTH]
]);
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

/** The seal of a chain once started; `null` once a start was tried and the key was unusable. */
export interface SealState {
	key: SealKey;
	tree: MerkleTree;
	segment: number;
	/** A line was written since the last checkpoint, the checkpoint line itself excepted. */
	pending: boolean;
	linkFile: string;
}

export interface ChainState {
	bootId: string;
	seq: number;
	prev: string;
	seal?: SealState | null;
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
	/** `on` lets `startSeal` start the seal of this writer's chain (#875). */
	seal?: LogSealSetting;
}

export interface StartSealOptions {
	/** `BP_LOG_SEAL_DIR`. Unset: one WARN, every line written unsealed. */
	dir: string | undefined;
	intervalSeconds: number;
	host?: string;
	proc?: Pick<NodeJS.EventEmitter, 'on'>;
}

/**
 * `flush()` writes the summary of every open flood window now, for a process about to stop, then
 * seals what was written since the last checkpoint. `startSeal` starts the seal of the chain once
 * per chain; `checkpoint()` seals now.
 */
export type LogWriter = ((event: LogEvent) => void) & {
	flush: () => void;
	startSeal: (options: StartSealOptions) => void;
	checkpoint: () => void;
};

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What a flood window counts, kept for its summary line. Every field is bounded by the code. */
interface FloodLabel {
	event: EventName;
	status?: number;
	route?: string;
	errorType?: string;
	/** The event's own `floodBy` attributes, copied onto the summary under their own names. */
	by: Record<string, string | number | boolean>;
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
	const by: FloodLabel['by'] = {};
	for (const key of REGISTRY[event.event].floodBy ?? []) {
		const value = attributes[key];
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			by[key] = value;
		}
	}
	return {
		event: event.event,
		...(typeof status === 'number' ? { status } : {}),
		...(request?.route ? { route: request.route } : {}),
		...(typeof errorType === 'string' ? { errorType } : {}),
		by
	};
}

const floodKey = (label: FloodLabel): string =>
	JSON.stringify([label.event, label.status, label.route, label.errorType, label.by]);

export function createLogWriter(options: WriterOptions): LogWriter {
	const chain = options.chain ?? processChain();
	const now = options.now ?? Date.now;
	const schedule =
		options.schedule ??
		((run: () => void, ms: number) => {
			setTimeout(run, ms).unref();
		});

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
			// The writer filters levels itself (`write` below), so pino lets every method through.
			level: 'debug',
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
				if (chain.seal) {
					chain.seal.tree.append(Buffer.from(finished, 'utf8'));
					chain.seal.pending = true;
				}
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
					...label.by,
					[A.suppressedCount]: suppressed,
					[A.suppressedWindowSeconds]: windowSeconds
				},
				undefined
			);
		},
		{ now, schedule }
	);

	/** Seal lines bypass the level and security filters: `write` applies those, not `emit`. */
	const emitSeal = (event: LogEvent) => {
		const spec = REGISTRY[event.event];
		emit(event.event, METHOD_OF[spec.severity], spec.body, event.attributes, undefined);
	};

	const checkpoint = () => {
		const seal = chain.seal;
		if (!seal?.pending) return;
		const fields = {
			origin: `${SEAL_KEY_NAME}/${chain.bootId}/${seal.segment}`,
			size: seal.tree.size,
			root: seal.tree.root(),
			timestamp: Math.floor(now() / 1000)
		};
		const note = signCheckpoint(fields, { name: SEAL_KEY_NAME, privateKey: seal.key.privateKey });
		// The checkpoint line is leaf 0 of the next segment.
		seal.tree = createMerkleTree();
		seal.segment += 1;
		emitSeal({ event: E.logCheckpoint, attributes: { [A.logCheckpointNote]: note } });
		seal.pending = false;
		writeLinkedCheckpoint(seal.linkFile, {
			origin: fields.origin,
			size: fields.size,
			root: fields.root.toString('base64')
		});
	};

	const startSeal = ({
		dir,
		intervalSeconds,
		host = hostname(),
		proc = process
	}: StartSealOptions) => {
		if (options.seal !== 'on' || chain.seal !== undefined) return;
		const key: SealKey | SealUnavailable =
			dir === undefined ? { reason: 'dir_unset' } : openSealKey(dir);
		if (dir === undefined || 'reason' in key) {
			const { reason, code } = key as SealUnavailable;
			chain.seal = null;
			emitSeal({
				event: E.logSealUnavailable,
				attributes: {
					[A.logSealReason]: reason,
					...(code === undefined ? {} : { [A.errorCode]: code })
				}
			});
			return;
		}
		const tag = hostTag(host);
		const linkFile = join(dir, `last-checkpoint.${tag}`);
		const previous = readLinkedCheckpoint(linkFile);
		chain.seal = { key, tree: createMerkleTree(), segment: 0, pending: false, linkFile };
		emitSeal({
			event: E.logSealStarted,
			attributes: {
				[A.logSealKeyId]: key.keyId,
				[A.logSealHost]: tag,
				[A.logSealPreviousOrigin]: previous?.origin ?? 'none',
				...(previous
					? { [A.logSealPreviousSize]: previous.size, [A.logSealPreviousRoot]: previous.root }
					: {})
			}
		});
		const tick = () => {
			checkpoint();
			schedule(tick, intervalSeconds * 1000);
		};
		schedule(tick, intervalSeconds * 1000);
		proc.on('sveltekit:shutdown', checkpoint);
		proc.on('exit', checkpoint);
	};

	const write = (event: LogEvent) => {
		const spec = REGISTRY[event.event];
		if (spec.security && options.securityLog === 'off') return;
		const method = METHOD_OF[spec.severity];
		if (LEVEL_RANK[method] < LEVEL_RANK[options.level]) return;
		const request = options.context?.();
		if (spec.flood) {
			const label = floodLabel(event, request);
			if (!admit(floodKey(label), label)) return;
		}
		emit(event.event, method, spec.body, event.attributes, request);
	};
	const flush = () => {
		admit.flush();
		checkpoint();
	};
	return Object.assign(write, { flush, startSeal, checkpoint });
}

/** A synchronous sink on file descriptor 1, so a line is out before a `process.exit` that follows. */
export function stdoutSink(): (line: string) => void {
	const destination = pino.destination({ dest: 1, sync: true });
	return (line) => {
		destination.write(line);
	};
}
