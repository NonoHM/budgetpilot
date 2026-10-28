import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { flushOnStop } from './index';

/**
 * #866, #1085: which process events write the open flood windows. Measured on the build of 4fb08df,
 * after SIGTERM: SQLite reached 'exit' in 17 ms, PostgreSQL in 9.8 s, MariaDB not within 20 s, so
 * Docker's 10 s SIGKILL ends the last two before 'exit'. adapter-node emits 'sveltekit:shutdown' once
 * the HTTP server has closed, whatever the pool does; 'exit' is the crash path (`process.exit(1)`).
 * The e2e capture runs on SQLite, where both arrive within 17 ms, so it cannot tell them apart.
 */
const flushesOn = (event: string) => {
	const proc = new EventEmitter();
	let flushed = 0;
	flushOnStop({ flush: () => (flushed += 1) }, proc);
	proc.emit(event);
	return flushed;
};

describe('flushOnStop', () => {
	it("flushes when adapter-node's server has closed, before the database pool lets the loop end", () => {
		expect(flushesOn('sveltekit:shutdown')).toBe(1);
	});

	it('flushes on exit, which follows the crash line', () => {
		expect(flushesOn('exit')).toBe(1);
	});

	it('listens to no signal, so it never removes the default exit of SIGINT or SIGTERM', () => {
		const proc = new EventEmitter();
		flushOnStop({ flush: () => {} }, proc);
		expect(proc.eventNames().toSorted()).toEqual(['exit', 'sveltekit:shutdown']);
	});
});
