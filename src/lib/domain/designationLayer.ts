/**
 * The import onion's layers (#1203), in its order: the member's past answer, the file proving it,
 * a rule or deterministic hint, the local model (B4, #1016), the member. The Prisma enum
 * `DesignationLayer` holds the same five names; `model` exists before its producer so B4 needs no
 * migration.
 */
export const DESIGNATION_LAYERS = ['remembered', 'file', 'rule', 'model', 'member'] as const;
export type DesignationLayer = (typeof DESIGNATION_LAYERS)[number];

/** What a remembered mapping holds for one role: its column under this file, and its stored layer. */
export interface RememberedRole {
	index: number | null;
	layer: DesignationLayer | null;
}

/**
 * Whether a row shows « Your choice »: it still holds the remembered column, and that column was
 * stored as the member's own pick. The only provenance a row states (#1278): a header match or a
 * date the file proves is already visible as the column name and its reading, as in Actual and
 * Firefly III, which show the mapped column and a parsed sample and no source label.
 */
export function isMemberChoice(input: {
	current: number | null;
	remembered: RememberedRole | null;
}): boolean {
	const { current, remembered } = input;
	return current !== null && remembered?.index === current && remembered.layer === 'member';
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
