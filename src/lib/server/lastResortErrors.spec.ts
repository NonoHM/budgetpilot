import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { OperatorFacingError } from './errors';
import { installLastResortErrorHandlers } from './lastResortErrors';

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
 */
const MARKER = 'L0MRK7c41q';

function fakeProcess() {
	const emitter = new EventEmitter();
	const written: string[] = [];
	const proc = Object.assign(emitter, {
		exit: vi.fn(),
		stderr: { write: vi.fn((text: string) => written.push(text)) }
	});
	return { proc, written };
}

function rowQuotingError() {
	return new PrismaClientKnownRequestError(`refused row Grocery ${MARKER}`, {
		code: 'P2003',
		clientVersion: '7',
		meta: { driverAdapterError: { cause: { originalMessage: `refused row Grocery ${MARKER}` } } }
	});
}

describe('installLastResortErrorHandlers', () => {
	it('reports an uncaught exception by class and code, and exits non-zero', () => {
		const { proc, written } = fakeProcess();
		installLastResortErrorHandlers(proc);

		proc.emit('uncaughtException', rowQuotingError(), 'unhandledRejection');

		expect(written).toEqual([
			'[budgetpilot] fatal unhandledRejection: PrismaClientKnownRequestError(P2003)\n'
		]);
		expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('reports an unhandled rejection the same way', () => {
		const { proc, written } = fakeProcess();
		installLastResortErrorHandlers(proc);

		proc.emit('unhandledRejection', rowQuotingError(), Promise.resolve());

		expect(written).toEqual([
			'[budgetpilot] fatal unhandledRejection: PrismaClientKnownRequestError(P2003)\n'
		]);
		expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it('keeps the message of a boot refusal written for the operator', () => {
		// The environment report is thrown from `init` too, and it is the operator's only way to
		// learn which variables are missing.
		const { proc, written } = fakeProcess();
		installLastResortErrorHandlers(proc);

		proc.emit(
			'uncaughtException',
			new OperatorFacingError('BOOTSTRAP_TOKEN is required'),
			'uncaughtException'
		);

		expect(written).toEqual([
			'[budgetpilot] fatal uncaughtException: OperatorFacingError: BOOTSTRAP_TOKEN is required\n'
		]);
	});
});
