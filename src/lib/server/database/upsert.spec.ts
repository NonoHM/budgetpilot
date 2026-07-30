import { describe, expect, it, vi } from 'vitest';
import { isUniqueConstraintViolation, withConcurrentWriteRetry } from './upsert';

/** A Prisma error as the client actually shapes it, for the codes this module matches on. */
function prismaError(code: string, driverCode?: string | number) {
	return Object.assign(new Error(`prisma error ${code}`), {
		code,
		meta:
			driverCode === undefined ? undefined : { driverAdapterError: { cause: { code: driverCode } } }
	});
}

describe('isUniqueConstraintViolation', () => {
	it('recognizes a unique-constraint violation', () => {
		expect(isUniqueConstraintViolation(prismaError('P2002'))).toBe(true);
	});

	it('rejects any other error, including things that are not errors at all', () => {
		expect(isUniqueConstraintViolation(prismaError('P2025'))).toBe(false);
		expect(isUniqueConstraintViolation(new Error('boom'))).toBe(false);
		expect(isUniqueConstraintViolation(null)).toBe(false);
		expect(isUniqueConstraintViolation('P2002')).toBe(false);
	});
});

describe('withConcurrentWriteRetry', () => {
	it('returns the first attempt when nothing goes wrong', async () => {
		const run = vi.fn().mockResolvedValue('row');

		await expect(withConcurrentWriteRetry(run)).resolves.toBe('row');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('retries once when a concurrent writer inserted the row first', async () => {
		// The whole point: the loser of the race asked for a row to exist, and by the time it
		// hears about the violation, it does.
		const run = vi.fn().mockRejectedValueOnce(prismaError('P2002')).mockResolvedValue('row');

		await expect(withConcurrentWriteRetry(run)).resolves.toBe('row');
		expect(run).toHaveBeenCalledTimes(2);
	});

	it.each([
		['MySQL record changed since last read', '1020'],
		['MySQL deadlock', 1213],
		['PostgreSQL serialization failure', '40001'],
		['PostgreSQL deadlock detected', '40P01']
	])('retries a transient write conflict: %s', async (_label, driverCode) => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(prismaError('P2039', driverCode))
			.mockResolvedValue('row');

		await expect(withConcurrentWriteRetry(run)).resolves.toBe('row');
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("retries Prisma's own write-conflict code", async () => {
		const run = vi.fn().mockRejectedValueOnce(prismaError('P2034')).mockResolvedValue('row');

		await expect(withConcurrentWriteRetry(run)).resolves.toBe('row');
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('does not retry a lock wait timeout, which is the one contention error that fails slowly', async () => {
		// MySQL 1205, after innodb_lock_wait_timeout (50s by default). Retrying it would hold the
		// request for minutes rather than seconds, so it is deliberately out of the allowlist.
		const failure = prismaError('P2039', '1205');
		const run = vi.fn().mockRejectedValue(failure);

		await expect(withConcurrentWriteRetry(run)).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('does not retry a driver error that is not about contention', async () => {
		// P2039 is Prisma's generic driver-error wrapper, which is exactly why the match is on
		// the allowlisted driver code underneath and not on P2039 itself. Retrying a syntax
		// error or a dropped connection would only hide it.
		const failure = prismaError('P2039', '1146');
		const run = vi.fn().mockRejectedValue(failure);

		await expect(withConcurrentWriteRetry(run)).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('does not retry an ordinary failure', async () => {
		const failure = new Error('column does not exist');
		const run = vi.fn().mockRejectedValue(failure);

		await expect(withConcurrentWriteRetry(run)).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('gives up after a bounded number of attempts and raises the last failure', async () => {
		// Retrying forever would turn a permanently conflicting write into a hung request.
		const failure = prismaError('P2002');
		const run = vi.fn().mockRejectedValue(failure);

		await expect(withConcurrentWriteRetry(run)).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(4);
	});
});
