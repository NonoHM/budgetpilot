import { describe, expect, it } from 'vitest';
import { createAdmission, type Admission, type Ticket } from './admission';

/**
 * Who may start a model generation (#535, R16 on #841). Each test names the two states it separates.
 * A refusal resolves at once, so `await` on it never waits; a queued request is a pending promise,
 * so the tests read `waiting` instead of awaiting it.
 */
const HOUR = 3_600_000;
const open = () => new AbortController().signal;
const isTicket = (outcome: unknown): outcome is Ticket =>
	typeof outcome === 'object' && outcome !== null && 'release' in outcome;
/** A caller that read the member's epoch just now, as the endpoint does before its switch read. */
const take = (admission: Admission, userId: string, outer: AbortSignal) =>
	admission.acquire(userId, outer, admission.epoch(userId));

describe('admission (#535)', () => {
	// One in flight and a room of `queueDepth`, versus an unbounded queue behind Ollama's own 512.
	it('admits one, lets the room fill to its depth, then refuses as busy at once', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const first = await take(admission, 'u1', open());
		expect(isTicket(first)).toBe(true);
		const second = take(admission, 'u2', open());
		void take(admission, 'u3', open());
		expect(admission.inFlight).toBe(1);
		expect(admission.waiting).toBe(2);
		expect(await take(admission, 'u4', open())).toBe('busy');
		(first as Ticket).release();
		expect(isTicket(await second)).toBe(true);
		expect(admission.inFlight).toBe(1);
		expect(admission.waiting).toBe(1);
	});

	// Depth 0 means no room at all, versus a room of one that the bound forgot.
	it('with depth 0, a second member is refused while one generates', async () => {
		const admission = createAdmission({ queueDepth: 0, hourlyQuota: 20, now: () => 0 });
		expect(isTicket(await take(admission, 'u1', open()))).toBe(true);
		expect(await take(admission, 'u2', open())).toBe('busy');
	});

	// A member's newer request replaces their running one, versus a member locked out by their own
	// earlier tab. Even with no room, the newer request may wait.
	it('a newer request aborts the same member running one and waits even with no room', async () => {
		const admission = createAdmission({ queueDepth: 0, hourlyQuota: 20, now: () => 0 });
		const older = (await take(admission, 'u1', open())) as Ticket;
		const newer = take(admission, 'u1', open());
		expect(older.signal.aborted).toBe(true);
		expect(admission.waiting).toBe(1);
		expect(await take(admission, 'u2', open())).toBe('busy');
		older.release();
		expect(isTicket(await newer)).toBe(true);
	});

	// Final pass F2: superseding a RUNNING generation goes to the BACK of the room, versus a member
	// who re-posts before each generation ends running next every time while others wait.
	it('a member superseding their running generation waits behind members already waiting', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		const second = take(admission, 'u2', open());
		void take(admission, 'u3', open());
		const again = take(admission, 'u1', open());
		expect(admission.waiting).toBe(3);
		running.release();
		expect(isTicket(await second)).toBe(true);
		void again;
	});

	// A newer request replaces the same member's WAITING one in place, versus going to the back and
	// leaving the older one to generate advice nobody is looking at.
	it('a newer request cancels the same member waiting one and keeps its place in line', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		const olderWaiting = take(admission, 'u2', open());
		const third = take(admission, 'u3', open());
		const newerWaiting = take(admission, 'u2', open());
		expect(await olderWaiting).toBe('cancelled');
		expect(admission.waiting).toBe(2);
		running.release();
		expect(isTicket(await newerWaiting)).toBe(true);
		expect(admission.waiting).toBe(1);
		void third;
	});

	// The requester leaving frees its place, versus a room filled by tabs that were closed.
	it('an outer abort while waiting leaves the room and frees the place', async () => {
		const admission = createAdmission({ queueDepth: 1, hourlyQuota: 20, now: () => 0 });
		await take(admission, 'u1', open());
		const outer = new AbortController();
		const waiting = take(admission, 'u2', outer.signal);
		outer.abort();
		expect(await waiting).toBe('cancelled');
		expect(admission.waiting).toBe(0);
		void take(admission, 'u3', open());
		expect(admission.waiting).toBe(1);
	});

	// An outer abort reaches the running generation, versus a closed tab still holding the GPU.
	it('an outer abort reaches the running ticket', async () => {
		const admission = createAdmission({ queueDepth: 1, hourlyQuota: 20, now: () => 0 });
		const outer = new AbortController();
		const running = (await take(admission, 'u1', outer.signal)) as Ticket;
		outer.abort();
		expect(running.signal.aborted).toBe(true);
	});

	// The window is half-open: an attempt at 0 counts at HOUR - 1 and not at HOUR. `>=` versus `>`.
	it('refuses the 21st generation in an hour and admits again once the first leaves the window', async () => {
		let t = 0;
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => t });
		for (let i = 0; i < 20; i++) ((await take(admission, 'u1', open())) as Ticket).release();
		expect(await take(admission, 'u1', open())).toBe('quota_reached');
		t = HOUR - 1;
		expect(await take(admission, 'u1', open())).toBe('quota_reached');
		t = HOUR;
		expect(isTicket(await take(admission, 'u1', open()))).toBe(true);
	});

	// The moment the quota lifts is the oldest start plus an hour, versus a sentence that can only
	// say « within the hour » while the server knows the minute.
	it('names when a member quota lifts: the oldest start in the window plus one hour', async () => {
		let t = 0;
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 2, now: () => t });
		expect(admission.quotaLiftsAt('u1')).toBeNull();
		((await take(admission, 'u1', open())) as Ticket).release();
		t = 600_000;
		((await take(admission, 'u1', open())) as Ticket).release();
		expect(admission.quotaLiftsAt('u1')).toBe(HOUR);
		t = HOUR;
		expect(admission.quotaLiftsAt('u1')).toBeNull();
	});

	// Quota per member, versus one member's use refusing another.
	it('counts the quota per member', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 1, now: () => 0 });
		((await take(admission, 'u1', open())) as Ticket).release();
		expect(await take(admission, 'u1', open())).toBe('quota_reached');
		expect(isTicket(await take(admission, 'u2', open()))).toBe(true);
	});

	// A refusal used no GPU, versus a busy model also eating the hourly quota of whoever waits.
	it('a busy refusal is not charged to the quota', async () => {
		const admission = createAdmission({ queueDepth: 0, hourlyQuota: 1, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		for (let i = 0; i < 5; i++) expect(await take(admission, 'u2', open())).toBe('busy');
		running.release();
		expect(isTicket(await take(admission, 'u2', open()))).toBe(true);
	});

	// A request cancelled before it started used no GPU, versus a period picker that burns the
	// quota one click at a time while the model is busy with someone else.
	it('a waiting request cancelled before it starts is not charged', async () => {
		const admission = createAdmission({ queueDepth: 1, hourlyQuota: 1, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		void take(admission, 'u2', open());
		const newer = take(admission, 'u2', open());
		running.release();
		expect(isTicket(await newer)).toBe(true);
	});

	// A refused request leaves the member's running one alone, versus a reload at the limit that
	// throws away the generation already paid for.
	it('a request refused for quota does not cancel the member running generation', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 1, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		expect(await take(admission, 'u1', open())).toBe('quota_reached');
		expect(running.signal.aborted).toBe(false);
	});

	// Turning the AI off stops that member's work, versus advice generated after the opt-out.
	it('cancelUser aborts the member running generation and cancels their waiting one, nobody else', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		const other = take(admission, 'u2', open());
		admission.cancelUser('u1');
		expect(running.signal.aborted).toBe(true);
		expect(admission.waiting).toBe(1);
		const queued = take(admission, 'u3', open());
		admission.cancelUser('u3');
		expect(await queued).toBe('cancelled');
		running.release();
		expect(isTicket(await other)).toBe(true);
	});

	// A request that read the switches before the opt-out and reaches admission after it, versus
	// one that read them after: only the first is stale, and it starts nothing.
	it('a request carrying an epoch from before cancelUser is cancelled, a fresh one is admitted', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const readBefore = admission.epoch('u1');
		admission.cancelUser('u1');
		expect(await admission.acquire('u1', open(), readBefore)).toBe('cancelled');
		expect(isTicket(await admission.acquire('u1', open(), admission.epoch('u1')))).toBe(true);
		expect(admission.epoch('u2')).toBe(admission.epoch('u3'));
	});

	// A second release is a no-op, versus a `finally` plus an abort handler freeing two places.
	it('releasing a ticket twice promotes one waiting request, not two', async () => {
		const admission = createAdmission({ queueDepth: 2, hourlyQuota: 20, now: () => 0 });
		const running = (await take(admission, 'u1', open())) as Ticket;
		void take(admission, 'u2', open());
		void take(admission, 'u3', open());
		running.release();
		running.release();
		expect(admission.inFlight).toBe(1);
		expect(admission.waiting).toBe(1);
	});
});
