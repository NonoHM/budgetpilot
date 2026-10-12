import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	chat,
	closeFakeHosts,
	envFor,
	fakeHost,
	stringRequest,
	tags,
	version
} from '../insights/fakeModelHost.fixture';

/**
 * #986: what the door does when it cannot tell whether the instance is halted. The database answer
 * is `inferenceHalt.db-smoke.ts`'s; this is the one state a real engine cannot be put in on demand,
 * a read that throws.
 */

const unreachable = async (): Promise<unknown> => {
	throw new Error('the database is unreachable');
};
const db = vi.hoisted(() => ({
	prisma: {
		inferenceHalt: {
			findUnique: vi.fn(),
			create: vi.fn(async () => ({}))
		}
	}
}));
vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { probeLocalLlm, requestLocalModel } = await import('../insights/local-llm');
const { haltInference } = await import('./inferenceHalt');
const { createLogWriter } = await import('$lib/server/logging/core');
const { EVENT, ATTRIBUTE } = await import('$lib/server/logging/names');

// The read's default is the throw; a queued answer a test did not consume must not reach the next
// test, or a break that skips the read reddens a neighbour instead of its own test.
beforeEach(() => {
	db.prisma.inferenceHalt.findUnique.mockReset();
	db.prisma.inferenceHalt.findUnique.mockImplementation(unreachable);
});
afterEach(closeFakeHosts);

describe('an unreadable halt refuses (#986)', () => {
	// Separates a door that fails closed from one that fails open: a switch whose state cannot be
	// read must not be read as « not halted », or an outage of the database is a way round it.
	it('refuses the call before any socket when the halt cannot be read', async () => {
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const result = await requestLocalModel(stringRequest(10), envFor(host));

		expect({ result, hits: host.hits }).toEqual({
			result: { unavailable: true, failureCode: 'halted', notCharged: true },
			hits: {}
		});
	});

	// The calibration: the same door, the same host, with a read that answers « not halted », does
	// reach the model, so the refusal above is the throw and not the fixture.
	it('reaches the model when the read answers that nothing is halted', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const result = await requestLocalModel(stringRequest(10), envFor(host));

		expect(result?.value).toEqual({ text: 'ok' });
	});
});

describe('a halt landing while the door is working (#986, design pass F4 and F5)', () => {
	// F5. The read answers « not halted » and, inside that same read, a halt commits and aborts what
	// is registered: the state a read just before the commit sees. Separates a door that registers
	// its call BEFORE reading (the abort reaches it, and the door refuses) from one that reads first
	// (the abort finds nothing, and the call reaches the model).
	it('refuses a call whose read raced a halt, because the call registered first', async () => {
		db.prisma.inferenceHalt.findUnique.mockImplementationOnce(async () => {
			await haltInference('admin-racing');
			return null;
		});
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const result = await requestLocalModel(stringRequest(10), envFor(host));

		expect({ result, chat: host.hits['/api/chat'] ?? 0 }).toEqual({
			result: { unavailable: true, failureCode: 'halted', notCharged: true },
			chat: 0
		});
	});

	// F4. The halt lands while the door reads the model list, before any generation. Separates a
	// halt named as one, and not charged, from the same abort read as an unreachable host, whose
	// advice (« check that it is running ») is false.
	it('names a halt during the model list read as halted, not unreachable', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		const host = await fakeHost({
			'/api/version': version,
			// Never answers on its own: only the halt below ends this read.
			'/api/tags': () => {},
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const pending = requestLocalModel(stringRequest(10), envFor(host));
		await vi.waitFor(() => expect(host.hits['/api/tags']).toBe(1));
		await haltInference('admin-during-tags');

		expect(await pending).toEqual({ unavailable: true, failureCode: 'halted', notCharged: true });
	});
	// The same during the reachability probe, the first socket the door opens.
	it('names a halt during the probe as halted, not unreachable', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		const host = await fakeHost({
			// Never answers on its own: only the halt below ends this probe.
			'/api/version': () => {},
			'/api/tags': tags(),
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const pending = requestLocalModel(
			stringRequest(10),
			envFor(host, { LLM_CONNECT_TIMEOUT_MS: '30000' })
		);
		await vi.waitFor(() => expect(host.hits['/api/version']).toBe(1));
		await haltInference('admin-during-probe');

		expect(await pending).toEqual({ unavailable: true, failureCode: 'halted', notCharged: true });
	});
});

describe('the rest of the door while halted (#986)', () => {
	// After the generation: the chat answered, and the halt lands while the door confirms which
	// weights answered. Separates an answer withheld and charged (the GPU did the work) from one
	// handed over, and from the same abort read as an unreachable host.
	it('withholds an answer when the halt lands during the read after the generation', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		let tagReads = 0;
		const host = await fakeHost({
			'/api/version': version,
			// The first read answers; the second never does, so only the halt ends it.
			'/api/tags': (req, res) => {
				tagReads += 1;
				if (tagReads === 1) tags()(req, res);
			},
			'/api/chat': chat(JSON.stringify({ text: 'ok' }))
		});

		const pending = requestLocalModel(stringRequest(10), envFor(host));
		await vi.waitFor(() => expect(tagReads).toBe(2));
		await haltInference('admin-after-answer');

		expect(await pending).toEqual({ unavailable: true, failureCode: 'halted' });
	});

	// Design pass F6c. The probe on its own, as a caller that keeps something to serve would use it.
	// Separates « halted » from « reachable » for a host that is up: the calibration below is the
	// same host answering reachable when nothing is halted.
	it('answers halted from the probe while halted, and reachable otherwise', async () => {
		const host = await fakeHost({ '/api/version': version });
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce({ id: 1 });
		const halted = await probeLocalLlm(envFor(host));
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		const reachable = await probeLocalLlm(envFor(host));

		expect({ halted, reachable, probes: host.hits['/api/version'] ?? 0 }).toEqual({
			halted: { unavailable: true, failureCode: 'halted', notCharged: true },
			reachable: null,
			probes: 1
		});
	});
});

describe('the abort does not depend on the write (#986, code pass item 1)', () => {
	afterEach(() => {
		db.prisma.inferenceHalt.create.mockReset();
		db.prisma.inferenceHalt.create.mockImplementation(async () => ({}));
	});

	// Separates a halt that stops the running call whatever its write does from one whose failed
	// write (a read-only disk, a deadlock, the halting admin deleted mid-request) skips the abort and
	// hands the answer over: the admin is shown an error, and the generation must still stop.
	it('aborts the running call even when the halt cannot be written', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		db.prisma.inferenceHalt.create.mockRejectedValueOnce(
			new Error('attempt to write a readonly database')
		);
		const host = await fakeHost({
			'/api/version': version,
			'/api/tags': tags(),
			// Never answers on its own: only an abort ends this generation.
			'/api/chat': () => {}
		});

		const pending = requestLocalModel(stringRequest(10), envFor(host, { LLM_TIMEOUT_MS: '30000' }));
		await vi.waitFor(() => expect(host.hits['/api/chat']).toBe(1));
		const written = await haltInference('admin-readonly').then(
			() => 'written',
			(caught: Error) => caught.message
		);

		expect({ written, result: await pending }).toEqual({
			written: 'attempt to write a readonly database',
			result: { unavailable: true, failureCode: 'halted' }
		});
	});
});

describe('the probe on its own while a halt lands (#986, code pass item 5)', () => {
	// Separates a probe that registers like the door (a halt during its socket answers halted) from
	// one that only reads the row first (the same halt answers reachable).
	it('answers halted when the halt lands during the probe socket', async () => {
		db.prisma.inferenceHalt.findUnique.mockResolvedValueOnce(null);
		const host = await fakeHost({ '/api/version': () => {} });

		const pending = probeLocalLlm(envFor(host, { LLM_CONNECT_TIMEOUT_MS: '30000' }));
		await vi.waitFor(() => expect(host.hits['/api/version']).toBe(1));
		await haltInference('admin-during-standalone-probe');

		expect(await pending).toEqual({ unavailable: true, failureCode: 'halted', notCharged: true });
	});
});

describe('the kill-switch events survive every log level (#986, design pass F1)', () => {
	// Through the real writer at `warn`, the strictest `BP_LOG_LEVEL` accepts: the level filter is
	// what a mocked `log` never runs. Separates a release logged at WARN from one at INFO, which an
	// instance at `warn` drops, leaving a lift with no record (AISVS C12.4.3).
	it('writes both lines at BP_LOG_LEVEL=warn with security logging off', () => {
		const lines: string[] = [];
		const write = createLogWriter({
			level: 'warn',
			securityLog: 'off',
			sink: (line) => lines.push(line)
		});
		const attributes = { [ATTRIBUTE.userPseudonym]: 'u_0123456789abcdef' } as never;

		write({ event: EVENT.aiInferenceHalted, attributes });
		write({ event: EVENT.aiInferenceResumed, attributes });

		expect(lines.map((line) => JSON.parse(line).event_name)).toEqual([
			EVENT.aiInferenceHalted,
			EVENT.aiInferenceResumed
		]);
	});
});
