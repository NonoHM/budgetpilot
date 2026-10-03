import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { OperatorFacingError } from './errors';
import { installLastResortErrorHandlers } from './lastResortErrors';
import type { LogEvent } from './logging';
import { ATTRIBUTE as A, EVENT as E } from './logging/names';

/**
 * #816, the boot path. `init` failing is rethrown by SvelteKit outside dev and reaches adapter-node's
 * top-level `await server.init`, where Node's own printer wrote the error with every nested
 * property: measured on the built server, a transaction label planted in a failing boot recompute
 * appeared in the captured log, through `meta.driverAdapterError.cause.originalMessage`.
 *
 * A fake process rather than the real one, because the real handler calls `exit`. That the real
 * process routes a rejected top-level await to these listeners was measured on Node 24 (it arrives
 * at `uncaughtException` with origin `unhandledRejection`); that the built server installs them is
 * the e2e in `e2e/error-printer.spec.ts`, which this spec cannot see.
 *
 * Each expectation is the WHOLE event, so an attribute riding along (a message, a nested property)
 * fails it.
 */
const MARKER = 'L0MRK7c41q';

function fakeProcess() {
	const emitter = new EventEmitter();
	const written: LogEvent[] = [];
	const proc = Object.assign(emitter, { exit: vi.fn() });
	return { proc, written, write: (event: LogEvent) => written.push(event) };
}

function rowQuotingError() {
	return new PrismaClientKnownRequestError(`refused row Grocery ${MARKER}`, {
		code: 'P2003',
		clientVersion: '7',
		meta: { driverAdapterError: { cause: { originalMessage: `refused row Grocery ${MARKER}` } } }
	});
}

describe('installLastResortErrorHandlers', () => {
	it('reports an uncaught exception as sys_crash, by class and code, and exits non-zero', () => {
		const { proc, written, write } = fakeProcess();
		installLastResortErrorHandlers(proc, write);

		proc.emit('uncaughtException', rowQuotingError(), 'unhandledRejection');

		expect(written).toEqual([
			{
				event: E.sysCrash,
				attributes: {
					[A.errorType]: 'PrismaClientKnownRequestError',
					[A.errorCode]: 'P2003',
					[A.crashOrigin]: 'unhandledRejection'
				}
			}
		]);
		expect(JSON.stringify(written)).not.toContain(MARKER);
		expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('reports an unhandled rejection the same way', () => {
		const { proc, written, write } = fakeProcess();
		installLastResortErrorHandlers(proc, write);

		proc.emit('unhandledRejection', rowQuotingError(), Promise.resolve());

		expect(written).toEqual([
			{
				event: E.sysCrash,
				attributes: {
					[A.errorType]: 'PrismaClientKnownRequestError',
					[A.errorCode]: 'P2003',
					[A.crashOrigin]: 'unhandledRejection'
				}
			}
		]);
		expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('keeps the message of a boot refusal written for the operator', () => {
		// The environment report is thrown from `init` too, and it is the operator's only way to
		// learn which variables are missing.
		const { proc, written, write } = fakeProcess();
		installLastResortErrorHandlers(proc, write);

		proc.emit(
			'uncaughtException',
			new OperatorFacingError('BOOTSTRAP_TOKEN is required'),
			'uncaughtException'
		);

		expect(written).toEqual([
			{
				event: E.sysCrash,
				attributes: {
					[A.errorType]: 'OperatorFacingError',
					[A.errorOperatorMessage]: 'BOOTSTRAP_TOKEN is required',
					[A.crashOrigin]: 'uncaughtException'
				}
			}
		]);
	});
});
