import * as m from '$lib/paraglide/messages';
import type { ImportFileError } from '$lib/server/import/file';

/**
 * The only place a refused upload becomes language, for BOTH import routes.
 *
 * `/import` kept this mapping privately and `/import/columns` had none: it answered « Le fichier de
 * relevé est vide. » for every code, so an unreadable workbook was reported there as empty (#595).
 * One function both call is what stops the two screens disagreeing about one file.
 *
 * No `default` arm, as in `refusalLabel.ts`: a code added to `IMPORT_FILE_ERROR_CODES` without a
 * sentence here fails to compile.
 */
export function importFileErrorLabel(err: ImportFileError): string {
	switch (err.code) {
		case 'too_large':
			return m.import_error_too_large({ size: err.params?.size ?? 0, max: err.params?.max ?? 0 });
		case 'expands_too_far':
			// Megabytes rather than bytes: the figures here are in the millions, and the number the
			// user can act on is "how much bigger than allowed", not the exact byte count.
			return m.import_error_expands_too_far({
				size: Math.ceil((err.params?.size ?? 0) / 1_000_000),
				max: Math.floor((err.params?.max ?? 0) / 1_000_000)
			});
		case 'bad_extension':
			return m.import_error_bad_extension();
		case 'unreadable_workbook':
			return m.import_error_unreadable_workbook();
		case 'empty':
			return m.import_error_empty_file();
		case 'exceeds_resource_ceiling':
			// UNCHANGED BY #595, and not true of this file: a file over the process's resource ceiling is
			// not empty. It is the sentence `/import` already showed (its mapping fell through to « vide »
			// for every code it did not name), kept rather than reworded here because choosing the right
			// one is a question about the bounds, reported beside this change instead of decided in it.
			return m.import_error_empty_file();
	}
}
