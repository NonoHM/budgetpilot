import { describe, expect, it } from 'vitest';
import { error } from '@sveltejs/kit';
import { userFacingErrorMessage } from './errors';

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
