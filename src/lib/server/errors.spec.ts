import { describe, expect, it } from 'vitest';
import { error } from '@sveltejs/kit';
import { inspect } from 'node:util';
import {
	PrismaClientKnownRequestError,
	PrismaClientValidationError
} from '@prisma/client/runtime/client';
import {
	describeErrorForLog,
	loggableError,
	OperatorFacingError,
	userFacingErrorMessage
} from './errors';

/**
 * #277. Four route servers each carried a private `getErrorMessage`, and three of them ended
 * `caught instanceof Error ? caught.message : <fallback>` — so ANY error thrown anywhere under the
 * action reached the page verbatim: a Prisma message, a Zod internal, a null dereference, in
 * English, on a French form.
 *
 * The measured instance was `RangeError: Invalid time value` (#275) landing under the date field
 * where « date ISO invalide » exists two lines away. #275 fixes that predicate; the BRANCH that
 * decided to show it is the general defect and is what this covers.
 *
 * The rule: only errors the application AUTHORED are user-facing. `isHttpError` identifies exactly
 * those — `error(400, m.…())` is a message someone chose for a reader — and everything else takes
 * the caller's own catalogue sentence.
 *
 * One helper rather than four copies, because a helper with this name is exactly the shape that
 * gets copied: `upcoming-bills` had already written the correct version independently, and the
 * other three had not. Four places that agree are four places free to drift.
 */
describe('userFacingErrorMessage', () => {
	it('passes through a message the application chose', () => {
		// `error()` from Kit is how this app says « this sentence is for the reader ».
		const authored = (() => {
			try {
				error(400, 'Montant invalide');
			} catch (caught) {
				return caught;
			}
		})();

		expect(userFacingErrorMessage(authored, 'FALLBACK')).toBe('Montant invalide');
	});

	it('refuses an Error nobody wrote for a reader, however readable it looks', () => {
		// The exact shape #275 measured. `RangeError.message` reads like a sentence, which is why
		// it survived review: nothing about it announces that it is internal.
		expect(userFacingErrorMessage(new RangeError('Invalid time value'), 'FALLBACK')).toBe(
			'FALLBACK'
		);
		expect(userFacingErrorMessage(new Error('connect ECONNREFUSED'), 'FALLBACK')).toBe('FALLBACK');
	});

	it('refuses a thrown non-Error too', () => {
		expect(userFacingErrorMessage('boom', 'FALLBACK')).toBe('FALLBACK');
		expect(userFacingErrorMessage(undefined, 'FALLBACK')).toBe('FALLBACK');
		expect(userFacingErrorMessage({ message: 'looks like one' }, 'FALLBACK')).toBe('FALLBACK');
	});
});

/**
 * #816. The other face of the same question: what a caught error may say to the OPERATOR's log.
 *
 * The marker stands for a user's data. The measurement that opened this (a database error raised
 * while writing a transaction whose label carried the marker, on the built server) found it in the
 * captured log on both paths: in Prisma's message on the request path, and in the nested
 * `meta.driverAdapterError.cause.originalMessage` that Node's printer walks on the boot path. So
 * the fixtures put it in BOTH places, and every assertion reads the whole serialised result, not a
 * field: a classifier that copied `meta` into its output would pass a test looking at `message`.
 */
const MARKER = 'L0MRK7c41q';

function prismaErrorQuotingARow(): PrismaClientKnownRequestError {
	return new PrismaClientKnownRequestError(
		`Invalid \`prisma.transaction.update()\` invocation:\n\nrefused row Grocery ${MARKER}`,
		{
			code: 'P2003',
			clientVersion: '7',
			meta: { driverAdapterError: { cause: { originalMessage: `refused row Grocery ${MARKER}` } } }
		}
	);
}

describe('loggableError', () => {
	it('keeps the class name and the code of a database error, and nothing it quoted', () => {
		const caught = prismaErrorQuotingARow();
		// Calibration in the same test: the fixture does carry the marker where the leak was measured.
		expect(caught.message).toContain(MARKER);
		expect(inspect(caught, { depth: null })).toContain(
			`originalMessage: 'refused row Grocery ${MARKER}'`
		);

		expect(loggableError(caught)).toEqual({ name: 'PrismaClientKnownRequestError', code: 'P2003' });
	});

	it('drops the message of a validation error, which quotes the arguments of the failed call', () => {
		const caught = new PrismaClientValidationError(`Argument \`label\`: "Grocery ${MARKER}"`, {
			clientVersion: '7'
		});

		expect(loggableError(caught)).toEqual({ name: 'PrismaClientValidationError' });
	});

	it('keeps the message of an error the application wrote for the operator', () => {
		// The boot report naming a missing variable is the reason this class exists: replacing it with
		// a class name would cost an operator a boot per variable, which assertConfigured.ts records.
		const caught = new OperatorFacingError('BOOTSTRAP_TOKEN is required');

		expect(loggableError(caught)).toEqual({
			name: 'OperatorFacingError',
			message: 'BOOTSTRAP_TOKEN is required'
		});
	});

	it('drops a code that is not a short upper-case token, because a code can be assigned anything', () => {
		const caught = Object.assign(new Error('x'), { code: `Grocery ${MARKER}` });

		expect(loggableError(caught)).toEqual({ name: 'Error' });
	});

	it('replaces a name that is not an identifier, because a name can be assigned anything too', () => {
		const caught = new Error('x');
		caught.name = `Grocery ${MARKER}`;

		expect(loggableError(caught)).toEqual({ name: 'Error' });
	});

	it('names only the type of a thrown value that is not an Error', () => {
		expect(loggableError(`Grocery ${MARKER}`)).toEqual({ name: 'string' });
		expect(loggableError({ message: MARKER })).toEqual({ name: 'object' });
		expect(loggableError(undefined)).toEqual({ name: 'undefined' });
	});
});

describe('describeErrorForLog', () => {
	it('writes the name and the code, and never the message, of a database error', () => {
		expect(describeErrorForLog(prismaErrorQuotingARow())).toBe(
			'PrismaClientKnownRequestError(P2003)'
		);
	});

	it("writes an operator-facing error's message after its name", () => {
		expect(describeErrorForLog(new OperatorFacingError('lock timed out'))).toBe(
			'OperatorFacingError: lock timed out'
		);
	});

	it('writes a bare name when there is no code', () => {
		expect(describeErrorForLog(new RangeError(MARKER))).toBe('RangeError');
	});
});
