import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogWriter, newChain, sha256Hex, type WriterOptions } from './core';
import { REGISTRY, type LogEvent } from './events';
import type { LogPseudonym, LogSubnetPseudonym, LogUserPseudonym } from './pseudonym';
import { FLOOD_ALLOWANCE, FLOOD_WINDOW_MS } from './flood';
import { ATTRIBUTE as A, EVENT as E, FIELD, SCHEMA_VERSION, SERVICE_NAME } from './names';
import { MAX_LINE_BYTES, MAX_OPERATOR_MESSAGE_LENGTH, MAX_VALUE_LENGTH } from './serialize';

/**
 * The writer, through its real pipeline: registry, level, flood gate, caps, pino, escaping, chain.
 * Only the sink, the clock and the scheduler are replaced, so every figure below is what the
 * shipped writer produces for the same event.
 *
 * Separator characters are built with String.fromCodePoint, never typed as escapes: a tool that
 * writes files from JSON turns the four-digit escape of U+2028 into the raw character.
 */

const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const ESC = String.fromCodePoint(0x1b);
const DEL = String.fromCodePoint(0x7f);
const NEL = String.fromCodePoint(0x85);
/** Every character a written line may not hold raw. LF is the terminator and is checked apart. */
// eslint-disable-next-line no-control-regex -- the detector exists to find control characters
const RAW_UNSAFE = /[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/u;

function harness(overrides: Partial<WriterOptions> = {}) {
	const lines: string[] = [];
	const scheduled: (() => void)[] = [];
	let clock = Date.UTC(2026, 9, 3, 12, 0, 0);
	const write = createLogWriter({
		level: 'info',
		securityLog: 'on',
		sink: (line) => lines.push(line),
		chain: newChain(),
		now: () => clock,
		schedule: (run) => scheduled.push(run),
		...overrides
	});
	return {
		write,
		lines,
		parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
		advance: (ms: number) => (clock += ms),
		runScheduled: () => scheduled.splice(0).forEach((run) => run())
	};
}

const crash = (operatorMessage?: string): LogEvent => ({
	event: E.sysCrash,
	attributes: {
		[A.crashOrigin]: 'unhandledRejection',
		[A.errorType]: 'OperatorFacingError',
		...(operatorMessage === undefined ? {} : { [A.errorOperatorMessage]: operatorMessage })
	}
});

const notFound = (): LogEvent => ({
	event: E.requestNotFound,
	attributes: { [A.httpStatus]: 404, [A.errorId]: '00000000-0000-4000-8000-000000000000' }
});

describe('the envelope', () => {
	it('is one JSON object per line on the OpenTelemetry names, UTC, severity on the 1 to 24 scale', () => {
		const { write, lines, parsed } = harness();
		write(crash());

		expect(lines).toHaveLength(1);
		expect(lines[0].endsWith('\n')).toBe(true);
		expect(lines[0].indexOf('\n')).toBe(lines[0].length - 1);
		const [line] = parsed();
		expect(line).toEqual({
			[FIELD.severityText]: 'FATAL',
			[FIELD.severityNumber]: 21,
			[FIELD.timestamp]: '2026-10-03T12:00:00.000Z',
			[FIELD.eventName]: E.sysCrash,
			[A.serviceName]: SERVICE_NAME,
			[A.crashOrigin]: 'unhandledRejection',
			[A.errorType]: 'OperatorFacingError',
			[A.logSchema]: SCHEMA_VERSION,
			[A.logBootId]: expect.stringMatching(/^[0-9a-f-]{36}$/),
			[A.logSeq]: 1,
			[A.logPrev]: '0'.repeat(64),
			[FIELD.body]: REGISTRY[E.sysCrash].body
		});
	});

	it('maps each severity to the first number of its OpenTelemetry range', () => {
		// One event per severity the registry uses, so a wrong pair in the map fails on its own row.
		const { write, parsed } = harness({ level: 'debug' });
		write({ event: E.backfillStarted, attributes: { [A.backfillName]: 'name_keys' } });
		write({ event: E.configOriginUnset, attributes: {} });
		write({ event: E.importAccountNotRemembered, attributes: {} });
		write({
			event: E.requestFailed,
			attributes: { [A.errorType]: 'TypeError', [A.httpStatus]: 500, [A.errorId]: 'x' }
		});
		write(crash());
		expect(parsed().map((line) => [line[FIELD.severityText], line[FIELD.severityNumber]])).toEqual([
			['INFO', 9],
			['WARN', 13],
			['WARN', 13],
			['ERROR', 17],
			['FATAL', 21]
		]);
	});

	it('carries the request id, method and route template inside a request, and no route outside one', () => {
		let context: { traceId: string; method: string; route: string | null } | undefined = {
			traceId: 'a'.repeat(32),
			method: 'POST',
			route: '/imports/[batchId]'
		};
		const { write, parsed } = harness({ context: () => context });
		write(notFound());
		context = { traceId: 'b'.repeat(32), method: 'GET', route: null };
		write(notFound());
		context = undefined;
		write(notFound());

		const [inside, unmatched, outside] = parsed();
		expect([inside[FIELD.traceId], inside[A.httpMethod], inside[A.httpRoute]]).toEqual([
			'a'.repeat(32),
			'POST',
			'/imports/[batchId]'
		]);
		expect([unmatched[FIELD.traceId], unmatched[A.httpMethod], A.httpRoute in unmatched]).toEqual([
			'b'.repeat(32),
			'GET',
			false
		]);
		expect([FIELD.traceId in outside, A.httpMethod in outside]).toEqual([false, false]);
	});
});

describe('the chain', () => {
	it('is one per process: a second writer continues the sequence and the hash the first left', () => {
		// boot.mjs imports this module as TypeScript source and the server imports the bundled copy,
		// so two writers exist in one process. Neither passes a chain, so both take the process one.
		const lines: string[] = [];
		const options = {
			level: 'info',
			securityLog: 'on',
			sink: (line: string) => lines.push(line)
		} as const;
		const boot = createLogWriter(options);
		const server = createLogWriter(options);
		boot({ event: E.bootMigrateFailed, attributes: { [A.bootExitCode]: 1 } });
		server({ event: E.bootMigrateFailed, attributes: { [A.bootExitCode]: 2 } });

		const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect({
			seq: (second[A.logSeq] as number) - (first[A.logSeq] as number),
			bootId: first[A.logBootId] === second[A.logBootId],
			prev: second[A.logPrev] === sha256Hex(lines[0].slice(0, -1))
		}).toEqual({ seq: 1, bootId: true, prev: true });
	});

	it('numbers every line and binds each to the hash of the line before it, as written', () => {
		const { write, lines, parsed } = harness();
		for (let index = 0; index < 5; index += 1) write(crash(`message ${index}`));

		const records = parsed();
		expect(records.map((record) => record[A.logSeq])).toEqual([1, 2, 3, 4, 5]);
		expect(records.map((record) => record[A.logPrev])).toEqual([
			'0'.repeat(64),
			...lines.slice(0, 4).map((line) => sha256Hex(line.slice(0, -1)))
		]);
		expect(new Set(records.map((record) => record[A.logBootId])).size).toBe(1);
	});

	it('detects an edited line: the next line no longer matches its hash', () => {
		const { write, lines } = harness();
		write(crash('original'));
		write(crash('next'));
		const edited = lines[0].replace('original', 'forgery');
		const next = JSON.parse(lines[1]) as Record<string, unknown>;
		expect([
			next[A.logPrev] === sha256Hex(lines[0].slice(0, -1)),
			next[A.logPrev] === sha256Hex(edited.slice(0, -1))
		]).toEqual([true, false]);
	});

	it('spends no sequence number on an event below the level', () => {
		const { write, parsed } = harness({ level: 'warn' });
		write(crash('first'));
		write({ event: E.backfillStarted, attributes: { [A.backfillName]: 'name_keys' } });
		write(crash('second'));
		expect(parsed().map((record) => record[A.logSeq])).toEqual([1, 2]);
	});
});

describe('escaping (v5.0.0-16.4.1)', () => {
	it('writes CR, LF, U+2028, U+2029, ESC, DEL and C1 escaped, and decodes them back', () => {
		const planted = `a\rb\nc${LS}d${PS}e${ESC}[31mf${DEL}g${NEL}h\ti`;
		const { write, lines, parsed } = harness();
		write(crash(planted));

		expect(RAW_UNSAFE.test(lines[0].slice(0, -1))).toBe(false);
		expect(lines[0].slice(0, -1).includes('\n')).toBe(false);
		expect(
			['\\u2028', '\\u2029', '\\u001b', '\\u007f', '\\u0085'].map((escape) =>
				lines[0].includes(escape)
			)
		).toEqual([true, true, true, true, true]);
		expect(parsed()[0][A.errorOperatorMessage]).toBe(planted);
	});

	it('holds for any string: one line, no raw unsafe character, the value decoded back', () => {
		fc.assert(
			// Half the characters drawn from the ones the serialiser exists for: drawn uniformly from all
			// of Unicode, U+2028 and U+2029 almost never appear, and a property that cannot reach them
			// stays green when their escaping is removed (measured: break B1 left it green).
			fc.property(
				fc.string({
					unit: fc.oneof(
						fc.constantFrom('\r', '\n', '\t', LS, PS, ESC, DEL, NEL, '"', '\\'),
						fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })
					),
					maxLength: 300
				}),
				(value) => {
					const { write, lines, parsed } = harness();
					write(crash(value));
					const line = lines[0].slice(0, -1);
					expect({
						lines: lines.length,
						newline: line.includes('\n'),
						raw: RAW_UNSAFE.test(line),
						decoded:
							parsed()[0][A.errorOperatorMessage] ===
							Array.from(value).slice(0, MAX_OPERATOR_MESSAGE_LENGTH).join('')
					}).toEqual({ lines: 1, newline: false, raw: false, decoded: true });
				}
			),
			{ numRuns: 500 }
		);
	});
});

describe('caps', () => {
	it('cuts an ordinary value at its cap on a code point boundary, and the operator message at its own', () => {
		const astral = String.fromCodePoint(0x1f600);
		const { write, parsed } = harness();
		write({
			event: E.configOriginSet,
			attributes: { [A.configOrigin]: astral.repeat(MAX_VALUE_LENGTH + 10) }
		});
		write(crash('m'.repeat(MAX_OPERATOR_MESSAGE_LENGTH + 10)));
		const [origin, message] = parsed();
		expect([
			Array.from(origin[A.configOrigin] as string).length,
			(origin[A.configOrigin] as string) === astral.repeat(MAX_VALUE_LENGTH),
			(message[A.errorOperatorMessage] as string).length
		]).toEqual([MAX_VALUE_LENGTH, true, MAX_OPERATOR_MESSAGE_LENGTH]);
	});

	it('replaces a line longer than the cap with line_too_long, keeping its envelope and its place in the chain', () => {
		// 2048 separators escape to six bytes each: past the cap after escaping, under it before.
		const { write, lines, parsed } = harness();
		write(crash(LS.repeat(MAX_OPERATOR_MESSAGE_LENGTH)));
		write(crash('after'));

		const [replaced, after] = parsed();
		expect({
			event: replaced[FIELD.eventName],
			original: replaced[A.suppressedEvent],
			droppedOverCap: (replaced[A.droppedBytes] as number) > MAX_LINE_BYTES,
			lineUnderCap: Buffer.byteLength(lines[0]) < MAX_LINE_BYTES,
			message: A.errorOperatorMessage in replaced,
			seq: replaced[A.logSeq],
			severity: replaced[FIELD.severityText],
			nextPrev: after[A.logPrev] === sha256Hex(lines[0].slice(0, -1))
		}).toEqual({
			event: E.logLineTooLong,
			original: E.sysCrash,
			droppedOverCap: true,
			lineUnderCap: true,
			message: false,
			seq: 1,
			severity: 'FATAL',
			nextPrev: true
		});
	});
});

const failed = (errorType: string, errorId: string): LogEvent => ({
	event: E.requestFailed,
	attributes: { [A.errorType]: errorType, [A.httpStatus]: 500, [A.errorId]: errorId }
});

describe('flood summarisation keeps a real failure visible (contradiction pass, item 1)', () => {
	// The window used to be keyed on the event and the status alone, so an anonymous visitor
	// repeating one 500 (#859 makes `POST /login` throw at will) turned every other 500 that
	// minute into a count, and the error id a real visitor was shown was never written.
	it('writes a 500 from another route inside a window an attacker filled', () => {
		let route = '/login';
		const { write, parsed } = harness({
			context: () => ({ traceId: 'a'.repeat(32), method: 'POST', route })
		});
		for (let index = 0; index < FLOOD_ALLOWANCE + 5; index += 1) {
			write(failed('TypeError', `attack-${index}`));
		}
		route = '/categories';
		write(failed('TypeError', 'the-real-one'));
		expect(parsed().some((line) => line[A.errorId] === 'the-real-one')).toBe(true);
	});

	it('writes a 500 of another error class on the same route inside a filled window', () => {
		const { write, parsed } = harness({
			context: () => ({ traceId: 'a'.repeat(32), method: 'POST', route: '/login' })
		});
		for (let index = 0; index < FLOOD_ALLOWANCE + 5; index += 1) {
			write(failed('TypeError', `attack-${index}`));
		}
		write(failed('PrismaClientKnownRequestError', 'the-real-one'));
		expect(parsed().some((line) => line[A.errorId] === 'the-real-one')).toBe(true);
	});

	it('names the route, the class and the status of what it counted in the summary line', () => {
		const { write, parsed, advance, runScheduled } = harness({
			context: () => ({ traceId: 'a'.repeat(32), method: 'POST', route: '/login' })
		});
		for (let index = 0; index < FLOOD_ALLOWANCE + 5; index += 1) {
			write(failed('TypeError', `attack-${index}`));
		}
		advance(FLOOD_WINDOW_MS);
		runScheduled();
		const summary = parsed().at(-1)!;
		expect([
			summary[FIELD.eventName],
			summary[A.suppressedEvent],
			summary[A.suppressedRoute],
			summary[A.suppressedErrorType],
			summary[A.suppressedStatus],
			summary[A.suppressedCount]
		]).toEqual([E.logSuppressed, E.requestFailed, '/login', 'TypeError', 500, 5]);
	});
});

describe('the summary line belongs to no request (contradiction pass, item 2)', () => {
	// AsyncLocalStorage carries the request that scheduled the timer into the timer's callback, so a
	// summary written there took that request's trace id, method and route as if it were its own.
	// Modelled here by a context that still answers when the scheduled callback runs.
	it('carries no trace id, method or route, whichever request scheduled it', () => {
		const { write, parsed, advance, runScheduled } = harness({
			context: () => ({ traceId: 'f'.repeat(32), method: 'GET', route: null })
		});
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(notFound());
		advance(FLOOD_WINDOW_MS);
		runScheduled();
		const summary = parsed().at(-1)!;
		expect([
			summary[FIELD.eventName],
			FIELD.traceId in summary,
			A.httpMethod in summary,
			A.httpRoute in summary
		]).toEqual([E.logSuppressed, false, false, false]);
	});
});

describe('flood summarisation', () => {
	it('writes the allowance, counts the rest, and writes one summary when the window closes', () => {
		const { write, parsed, advance, runScheduled } = harness();
		for (let index = 0; index < FLOOD_ALLOWANCE + 5; index += 1) write(notFound());
		expect(parsed()).toHaveLength(FLOOD_ALLOWANCE);

		advance(FLOOD_WINDOW_MS);
		runScheduled();
		const summary = parsed().at(-1)!;
		expect([
			summary[FIELD.eventName],
			summary[A.suppressedEvent],
			summary[A.suppressedCount],
			summary[A.suppressedWindowSeconds],
			parsed().length
		]).toEqual([
			E.logSuppressed,
			E.requestNotFound,
			5,
			FLOOD_WINDOW_MS / 1000,
			FLOOD_ALLOWANCE + 1
		]);
	});

	it('opens a fresh window after the last one closed', () => {
		const { write, parsed, advance, runScheduled } = harness();
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(notFound());
		advance(FLOOD_WINDOW_MS);
		runScheduled();
		write(notFound());
		expect(
			parsed()
				.map((line) => line[FIELD.eventName])
				.slice(-2)
		).toEqual([E.logSuppressed, E.requestNotFound]);
	});

	it('never summarises an event the registry does not mark as reachable without a session', () => {
		const { write, parsed } = harness();
		for (let index = 0; index < FLOOD_ALLOWANCE + 5; index += 1) write(crash(String(index)));
		expect(parsed()).toHaveLength(FLOOD_ALLOWANCE + 5);
	});
});

describe('BP_SECURITY_LOG', () => {
	it('drops an event marked as a security event when off, and writes it when on', () => {
		// No event in this pull request is a security event (L3 adds the first), so one is marked
		// for the duration of this test to read the filter itself, then restored.
		const spec = REGISTRY[E.configOriginUnset] as { security: boolean };
		spec.security = true;
		try {
			const off = harness({ securityLog: 'off' });
			const on = harness({ securityLog: 'on' });
			off.write({ event: E.configOriginUnset, attributes: {} });
			on.write({ event: E.configOriginUnset, attributes: {} });
			expect([off.lines.length, on.lines.length]).toEqual([0, 1]);
		} finally {
			spec.security = false;
		}
	});
});

describe('floodBy: a summarised authentication event splits its window by its own field (L3)', () => {
	// The window key was the event, status, route and class. Twenty cookies of reason `unknown`,
	// which anyone can send for free, filled `budgetpilot.session.invalid`'s window on a route, and
	// the replay of a REVOKED cookie on that route became an anonymous count (contradiction pass on
	// L3's design note). Each test below separates exactly that pair of states.
	const user = (hex: string) => hex.repeat(64) as LogUserPseudonym;
	const dead = (reason: 'unknown' | 'revoked', pseudonym?: LogUserPseudonym): LogEvent => ({
		event: E.sessionInvalid,
		attributes: {
			...(pseudonym === undefined ? {} : { [A.userPseudonym]: pseudonym }),
			[A.sessionReason]: reason
		}
	});
	const onRoute = { context: () => ({ traceId: 'a'.repeat(32), method: 'GET', route: '/' }) };

	it('counts the cheap repeats past the allowance: the window this file relies on does fill', () => {
		const { write, parsed } = harness(onRoute);
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(dead('unknown'));
		expect(parsed().length).toBe(FLOOD_ALLOWANCE);
	});

	it('writes a revoked replay inside the window twenty unknown cookies filled', () => {
		const { write, parsed } = harness(onRoute);
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(dead('unknown'));
		write(dead('revoked', user('b')));
		expect(parsed().at(-1)?.[A.sessionReason]).toBe('revoked');
	});

	it("gives each user's revoked replays a window of their own", () => {
		const { write, parsed } = harness(onRoute);
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(dead('revoked', user('c')));
		write(dead('revoked', user('d')));
		expect(parsed().at(-1)?.[A.userPseudonym]).toBe(user('d'));
	});

	it('names the reason and the user it counted in the summary line', () => {
		const { write, parsed, advance, runScheduled } = harness(onRoute);
		for (let index = 0; index < FLOOD_ALLOWANCE + 3; index += 1) write(dead('revoked', user('e')));
		advance(FLOOD_WINDOW_MS);
		runScheduled();
		const summary = parsed().at(-1)!;
		expect([
			summary[FIELD.eventName],
			summary[A.suppressedEvent],
			summary[A.sessionReason],
			summary[A.userPseudonym],
			summary[A.suppressedCount]
		]).toEqual([E.logSuppressed, E.sessionInvalid, 'revoked', user('e'), 3]);
	});
});

describe('the subnet fields exist on attack events only (#936 point 1), by type', () => {
	// Compile time: `npm run check` fails if a success event accepts the field. Run time: the
	// event is still built, so the test asserts what it built, and vitest's assertion count holds.
	it('refuses a subnet label on a successful sign-in, written or spread', () => {
		const hash = '0'.repeat(64);
		// @ts-expect-error a success event has no subnet label, written as a literal
		const success: LogEvent = {
			event: E.authnLoginSuccess,
			attributes: {
				[A.clientPseudonym]: hash as LogPseudonym,
				[A.userPseudonym]: hash as LogUserPseudonym,
				[A.authnFactor]: 'password',
				[A.clientSubnetPseudonym]: hash as LogSubnetPseudonym
			}
		};
		const attack = {
			[A.clientPseudonym]: hash as LogPseudonym,
			[A.clientSubnetPseudonym]: hash as LogSubnetPseudonym,
			[A.clientSubnetPrefixLength]: 32
		};
		// @ts-expect-error nor spread from an attack event's client fields, which a plain type allowed
		const spread: LogEvent = {
			event: E.authnLoginSuccess,
			attributes: {
				...attack,
				[A.userPseudonym]: hash as LogUserPseudonym,
				[A.authnFactor]: 'totp'
			}
		};
		expect([success.event, spread.event]).toEqual([E.authnLoginSuccess, E.authnLoginSuccess]);
	});
});

describe("floodBy: a victim's refusal survives a window one address filled (second contradiction pass)", () => {
	// A LOGIN refusal costs no password hash, so one address can fill the window. The refusal of an
	// owner whose EMAIL counter someone else filled (`counter: subject`) is the line an operator needs,
	// and it has a window of its own.
	const refusal = (counter: 'address' | 'subject'): LogEvent => ({
		event: E.rateLimitExceeded,
		attributes: {
			[A.clientPseudonym]: 'a'.repeat(64) as LogPseudonym,
			[A.clientSubnetPseudonym]: 'b'.repeat(64) as LogSubnetPseudonym,
			[A.clientSubnetPrefixLength]: 32,
			[A.rateLimitKind]: 'LOGIN',
			[A.rateLimitCounter]: counter
		}
	});

	it('writes a subject refusal after twenty-one address refusals in the same minute', () => {
		const { write, parsed } = harness({
			context: () => ({ traceId: 'a'.repeat(32), method: 'POST', route: '/login' })
		});
		for (let index = 0; index < FLOOD_ALLOWANCE + 1; index += 1) write(refusal('address'));
		write(refusal('subject'));
		expect([parsed().length, parsed().at(-1)?.[A.rateLimitCounter]]).toEqual([
			FLOOD_ALLOWANCE + 1,
			'subject'
		]);
	});
});
