import type { ColumnDateState } from '$lib/server/import/columnDateState';
import type { DesignationRole } from './mappingRoles';

/**
 * The import onion's layers (#1203), in its order: the member's past answer, the file proving it,
 * a rule or deterministic hint, the local model (B4, #1016), the member. The Prisma enum
 * `DesignationLayer` holds the same five names; `model` exists before its producer so B4 needs no
 * migration.
 */
export const DESIGNATION_LAYERS = ['remembered', 'file', 'rule', 'model', 'member'] as const;
export type DesignationLayer = (typeof DESIGNATION_LAYERS)[number];

/** A reason is a file fact named by a code, rendered by Paraglide; never free text from a model. */
export type ProvenanceReason =
	| { code: 'header'; header: string }
	| { code: 'currency-codes' }
	| { code: 'date-order'; order: 'day-first' | 'month-first' }
	/** `proven-shape`: every date reads the same either way (ISO, or a day equal to its month). */
	| { code: 'date-single-reading' }
	| { code: 'kept'; from: 'file' | 'member' | 'unknown' };

export interface Provenance {
	layer: 'remembered' | 'file' | 'rule';
	reason: ProvenanceReason;
}

/** What a remembered mapping holds for one role: its column under this file, and its stored layer. */
export interface RememberedRole {
	index: number | null;
	layer: DesignationLayer | null;
}

const DATE_REASON: Partial<Record<ColumnDateState, ProvenanceReason>> = {
	'proven-day': { code: 'date-order', order: 'day-first' },
	'proven-month': { code: 'date-order', order: 'month-first' },
	'proven-shape': { code: 'date-single-reading' }
};

/**
 * The line under one row, or null when the row shows the member's own value.
 *
 * A detected value's layer follows from `columnProposals`' rule: under a header row it designates by
 * header name only (a rule), and without one it designates only the currency, by its values (the
 * file). `designationLayer.premise.spec.ts` reds if the producer stops holding to that.
 *
 * The line exists only while the row still holds the column that was detected or remembered: the
 * member's change makes the value theirs (IBM Carbon AI label, the account row's `accountHintShown`).
 */
export function rowProvenance(input: {
	role: DesignationRole;
	current: number | null;
	detected: number | null;
	remembered: RememberedRole | null;
	hasHeaderRow: boolean;
	header?: string;
	dateState?: ColumnDateState;
}): Provenance | null {
	const { role, current, detected, remembered, hasHeaderRow } = input;
	if (current === null) return null;
	if (remembered !== null && remembered.index === current) {
		const from =
			remembered.layer === null ? 'unknown' : remembered.layer === 'member' ? 'member' : 'file';
		return { layer: 'remembered', reason: { code: 'kept', from } };
	}
	if (current !== detected) return null;
	const dateReason = role === 'date' && input.dateState ? DATE_REASON[input.dateState] : undefined;
	if (dateReason) return { layer: 'file', reason: dateReason };
	if (hasHeaderRow)
		return { layer: 'rule', reason: { code: 'header', header: input.header ?? '' } };
	return { layer: 'file', reason: { code: 'currency-codes' } };
}

/**
 * The layer the server stores for one kept role, from its OWN computation (ASVS v5.0.0-8.3.1), never
 * from the form. A mapping is saved only under a header row, so a detected value is a `rule`. A
 * remembered value keeps the layer it was first stored with, and an unknown one (written before
 * 1.4) stays unknown rather than being promoted.
 */
export function layerAtSave(input: {
	posted: number | null;
	detected: number | null;
	remembered: RememberedRole | null;
}): DesignationLayer | null {
	const { posted, detected, remembered } = input;
	if (posted === null) return null;
	if (remembered !== null && remembered.index === posted) return remembered.layer;
	if (posted === detected) return 'rule';
	return 'member';
}
