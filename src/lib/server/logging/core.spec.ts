import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogWriter, newChain, sha256Hex, type WriterOptions } from './core';
import { REGISTRY, type LogEvent } from './events';
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
		write({ event: E.configOriginSet, attributes: { [A.configOrigin]: 'https://example.test' } });
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
		write({ event: E.configOriginSet, attributes: { [A.configOrigin]: 'https://example.test' } });
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
