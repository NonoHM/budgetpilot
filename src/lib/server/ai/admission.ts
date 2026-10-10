/**
 * Who may start a model generation now (#535, R16 on #841). One generation in flight, a bounded
 * waiting room, one request per member (the newest wins), and an hourly quota per member. Anything
 * past the room is refused AT ONCE rather than queued behind Ollama's own 512 slots, which is what
 * let one hover spend 9.7 s of GPU per prefetch.
 *
 * Pure and clock-injected, with no SvelteKit or Prisma import, so every boundary is testable without
 * a timer and the module can be lifted elsewhere (spec section 10, « Reuse beyond this app »).
 *
 * THE QUOTA IS CHARGED WHEN A GENERATION STARTS, NOT WHEN A REQUEST ARRIVES. A request refused as
 * busy, or cancelled while it waited, used no GPU; charging it would let a busy model or a period
 * picker clicked five times eat the hourly allowance of whoever is waiting. It is CHECKED on arrival,
 * so a member at the limit is told at once and their running generation is left alone.
 */

/**
 * `cancelled` renders nothing: a newer request of the same member took this one's place, the caller
 * left, or the member turned the AI off. Nobody is waiting for a sentence about it.
 */
export type AdmissionRefusal = 'busy' | 'quota_reached' | 'cancelled';

export interface Ticket {
	/** Aborted when a newer request of the same member arrives, the caller leaves, or `cancelUser`. */
	signal: AbortSignal;
	/** Frees the slot for the next waiting request. Idempotent, so a `finally` cannot free two. */
	release(): void;
	/**
	 * Takes this generation's start back out of the member's quota, once: for a failure the model
	 * did no work on (the gateway decides which). Never for a generation the GPU worked on.
	 */
	refund(): void;
}

export interface Admission {
	/**
	 * `epoch` is `epoch(userId)` read by the caller BEFORE it read the member's AI switches. A
	 * `cancelUser` landing between that read and this call moves the epoch, and the request is then
	 * `cancelled` instead of generating after the opt-out.
	 */
	acquire(userId: string, outer: AbortSignal, epoch: number): Promise<Ticket | AdmissionRefusal>;
	epoch(userId: string): number;
	/** The member's running generation is aborted and their waiting request cancelled. */
	cancelUser(userId: string): void;
	/** When a member at their quota may start again; `null` when they are below it. */
	quotaLiftsAt(userId: string): number | null;
	/** Whether this member's generation is the one running now. */
	isRunning(userId: string): boolean;
	readonly inFlight: number;
	readonly waiting: number;
}

const WINDOW_MS = 3_600_000;

interface Entry {
	userId: string;
	controller: AbortController;
	resolve: (outcome: Ticket | AdmissionRefusal) => void;
}

export function createAdmission(options: {
	queueDepth: number;
	hourlyQuota: number;
	now: () => number;
}): Admission {
	let running: { userId: string; controller: AbortController } | null = null;
	const queue: Entry[] = [];
	const starts = new Map<string, number[]>();
	const epochs = new Map<string, number>();

	/** Starts inside the last hour, pruned on every read so the map holds at most an hour per member. */
	function recentStarts(userId: string): number[] {
		const since = options.now() - WINDOW_MS;
		const recent = (starts.get(userId) ?? []).filter((at) => at > since);
		if (recent.length > 0) starts.set(userId, recent);
		else starts.delete(userId);
		return recent;
	}

	function start(userId: string, controller: AbortController): Ticket {
		running = { userId, controller };
		const startedAt = options.now();
		starts.set(userId, [...recentStarts(userId), startedAt]);
		let released = false;
		let refunded = false;
		return {
			signal: controller.signal,
			refund() {
				if (refunded) return;
				refunded = true;
				const own = starts.get(userId) ?? [];
				const at = own.indexOf(startedAt);
				if (at >= 0) own.splice(at, 1);
			},
			release() {
				if (released) return;
				released = true;
				running = null;
				const next = queue.shift();
				if (next) next.resolve(start(next.userId, next.controller));
			}
		};
	}

	function cancelWaiting(userId: string): number {
		const at = queue.findIndex((entry) => entry.userId === userId);
		if (at < 0) return -1;
		const [entry] = queue.splice(at, 1);
		entry.resolve('cancelled');
		return at;
	}

	return {
		get inFlight() {
			return running ? 1 : 0;
		},
		get waiting() {
			return queue.length;
		},
		epoch(userId) {
			return epochs.get(userId) ?? 0;
		},
		isRunning(userId) {
			return running?.userId === userId;
		},
		quotaLiftsAt(userId) {
			const recent = recentStarts(userId);
			if (recent.length < options.hourlyQuota) return null;
			// Starts are appended in clock order, so this is the start whose leaving the window brings
			// the count back under the quota.
			return recent[recent.length - options.hourlyQuota] + WINDOW_MS;
		},
		cancelUser(userId) {
			epochs.set(userId, (epochs.get(userId) ?? 0) + 1);
			if (running?.userId === userId) running.controller.abort();
			cancelWaiting(userId);
		},
		acquire(userId, outer, epoch) {
			if (epoch !== (epochs.get(userId) ?? 0) || outer.aborted) return Promise.resolve('cancelled');
			if (recentStarts(userId).length >= options.hourlyQuota) {
				return Promise.resolve('quota_reached');
			}

			// The newest request of a member replaces the older one. A WAITING one is replaced in place.
			// A RUNNING one is aborted and the newer request waits at the BACK of the room, even when the
			// room is full: the member was already admitted once, and refusing them as busy because of
			// their own earlier tab is the lockout spec F8 describes; but the head of the room would let
			// a member who re-posts before each generation ends run next every time (final pass F2).
			// The room may therefore hold one more than its depth, and only for that reason.
			const supersedesRunning = running?.userId === userId;
			if (supersedesRunning) running!.controller.abort();
			const replacedAt = cancelWaiting(userId);

			if (running && !supersedesRunning && replacedAt < 0 && queue.length >= options.queueDepth) {
				return Promise.resolve('busy');
			}

			const controller = new AbortController();
			const onOuterAbort = () => controller.abort();
			outer.addEventListener('abort', onOuterAbort, { once: true });
			if (!running) return Promise.resolve(start(userId, controller));

			return new Promise((resolve) => {
				const entry: Entry = { userId, controller, resolve };
				if (replacedAt >= 0) queue.splice(replacedAt, 0, entry);
				else queue.push(entry);
				controller.signal.addEventListener(
					'abort',
					() => {
						const at = queue.indexOf(entry);
						if (at >= 0) {
							queue.splice(at, 1);
							resolve('cancelled');
						}
					},
					{ once: true }
				);
			});
		}
	};
}
