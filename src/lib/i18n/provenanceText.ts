import * as m from '$lib/paraglide/messages';
import type { Provenance } from '$lib/domain/designationLayer';

/**
 * The words of one provenance line (#1207): the layer's label and the file fact that is its reason.
 * The one place a `Provenance` becomes text, so the screen and the recap cannot word a layer twice.
 * A header cell is the file's own text and reaches here already bounded by the caller
 * (`refusalCellValue`).
 */
export function provenanceText(provenance: Provenance): { label: string; reason: string } {
	const label =
		provenance.layer === 'rule'
			? m.import_columns_provenance_rule()
			: provenance.layer === 'file'
				? m.import_columns_provenance_file()
				: m.import_columns_provenance_remembered();
	const r = provenance.reason;
	const reason =
		r.code === 'header'
			? m.import_columns_provenance_reason_header({ header: r.header })
			: r.code === 'currency-codes'
				? m.import_columns_provenance_reason_currency_codes()
				: r.code === 'date-order'
					? r.order === 'day-first'
						? m.import_columns_provenance_reason_day_first()
						: m.import_columns_provenance_reason_month_first()
					: r.code === 'date-single-reading'
						? m.import_columns_provenance_reason_single_reading()
						: r.from === 'file'
							? m.import_columns_provenance_reason_kept_file()
							: r.from === 'member'
								? m.import_columns_provenance_reason_kept_member()
								: m.import_columns_provenance_reason_kept_unknown();
	return { label, reason };
}
