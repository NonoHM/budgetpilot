import * as m from '$lib/paraglide/messages';
import type { ImportWriteRefusal } from '$lib/server/import/writeImport';
import { refusalLabel } from './refusalLabel';

/**
 * The only place a failed import WRITE becomes language (#662). Both import routes call it, so the
 * two screens cannot describe one failure two ways.
 *
 * Each sentence says what is known and the repair that fits it, and no more: the write is not one
 * transaction, so « nothing was saved » is said only where nothing can have been. The repair for a
 * partial import is the one `/imports` already offers (delete it, which removes every row it filed),
 * because retrying on top of it would file the rest beside a partial batch and would not repair a
 * row whose répartition never landed.
 *
 * No `default` arm, as in `refusalLabel.ts`: a member added to the union without a sentence here
 * fails to compile.
 */
export function importWriteFailureLabel(failure: ImportWriteRefusal): string {
	switch (failure.kind) {
		case 'currency':
			return refusalLabel(failure.fact);
		case 'nothing-saved':
			return m.import_error_write_nothing_saved();
		case 'partly-saved':
			return failure.landedRows === 1
				? m.import_error_write_partly_saved_one({ count: failure.landedRows })
				: m.import_error_write_partly_saved_many({ count: failure.landedRows });
		case 'maybe-saved':
			return m.import_error_write_maybe_saved();
	}
}
