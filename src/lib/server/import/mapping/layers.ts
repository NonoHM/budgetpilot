import { createHash } from 'node:crypto';
import {
	DESIGNATION_LAYERS,
	layerAtSave,
	type DesignationLayer
} from '$lib/domain/designationLayer';
import { columnProposals } from '../columnProposals';
import type { ParsedCsvRow } from '../types';
import type { ColumnMappingInput, MappingRole, UntrustedColumnMapping } from './model';
import { designationAssignment } from './recap';

/** The four stored layers, one per role a mapping keeps (#1207). */
export interface ColumnMappingLayers {
	dateLayer: DesignationLayer | null;
	labelLayer: DesignationLayer | null;
	amountLayer: DesignationLayer | null;
	categoryLayer: DesignationLayer | null;
}

/** For a writer that has no onion to consult: every layer unknown. */
export const UNKNOWN_LAYERS: ColumnMappingLayers = {
	dateLayer: null,
	labelLayer: null,
	amountLayer: null,
	categoryLayer: null
};

const FIELD: Record<MappingRole, keyof ColumnMappingLayers> = {
	date: 'dateLayer',
	label: 'labelLayer',
	amount: 'amountLayer',
	category: 'categoryLayer'
};

/** The same four layers keyed by role, which is how the designation screen reads them. */
export function layersByRole(
	layers: ColumnMappingLayers
): Record<MappingRole, DesignationLayer | null> {
	return {
		date: layers.dateLayer,
		label: layers.labelLayer,
		amount: layers.amountLayer,
		category: layers.categoryLayer
	};
}

/** A stored layer, read positively against the closed list (ASVS v5.0.0-2.2.1): anything else is unknown. */
export function readStoredLayer(value: unknown): DesignationLayer | null {
	return (DESIGNATION_LAYERS as readonly unknown[]).includes(value)
		? (value as DesignationLayer)
		: null;
}

/**
 * Which role columns a mapping's layers were written FOR: SHA-256 over the role fields, 64 hex.
 *
 * B2a's `manualCategorySourceKey` pattern (#1013). A version older than 1.4 upserts the role columns
 * and leaves the layer columns as they were, so after a rollback and back a layer could describe a
 * column the member re-designated in between. `storedLayers` counts the layers only while this key
 * still matches, and reads unknown otherwise, which is the safe direction.
 */
/** Exactly the fields the key covers: the role columns, and how they are matched. */
type LayersKeyFields = Pick<
	UntrustedColumnMapping,
	| 'matchBy'
	| 'dateColumn'
	| 'labelColumn'
	| 'amountColumn'
	| 'categoryColumn'
	| 'dateIndex'
	| 'labelIndex'
	| 'amountIndex'
	| 'categoryIndex'
>;

export function layersKeyOf(mapping: LayersKeyFields): string {
	const fields = [
		mapping.matchBy,
		mapping.dateColumn,
		mapping.labelColumn,
		mapping.amountColumn,
		mapping.categoryColumn,
		mapping.dateIndex,
		mapping.labelIndex,
		mapping.amountIndex,
		mapping.categoryIndex
	];
	return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** The one reader of stored layers: each read positively, and all unknown unless the key matches. */
export function storedLayers(
	row: UntrustedColumnMapping &
		Partial<Record<keyof ColumnMappingLayers, unknown>> & { layersKey?: string | null }
): ColumnMappingLayers {
	if (row.layersKey !== layersKeyOf(row)) return { ...UNKNOWN_LAYERS };
	return {
		dateLayer: readStoredLayer(row.dateLayer),
		labelLayer: readStoredLayer(row.labelLayer),
		amountLayer: readStoredLayer(row.amountLayer),
		categoryLayer: readStoredLayer(row.categoryLayer)
	};
}

/**
 * What a backup restore may write: only a layer `layerAtSave` could have produced for that role. A
 * backup is an uploaded file, so its layers are a claim; anything outside this reads unknown rather
 * than refusing the whole restore. Saved mappings exist only under a header row, so a stored role is
 * `rule` (detected by its header) or `member`; the category is never detected, so only `member`.
 */
export function producibleLayers(
	mapping: UntrustedColumnMapping,
	layers: Partial<Record<keyof ColumnMappingLayers, unknown>>
): ColumnMappingLayers {
	const out: ColumnMappingLayers = { ...UNKNOWN_LAYERS };
	for (const role of Object.keys(FIELD) as MappingRole[]) {
		const field = FIELD[role];
		const value = readStoredLayer(layers[field]);
		const held = mapping[`${role}Column`] !== null || mapping[`${role}Index`] !== null;
		const allowed =
			role === 'category' ? value === 'member' : value === 'rule' || value === 'member';
		out[field] = held && allowed ? value : null;
	}
	return out;
}

/**
 * What the server stores beside a mapping it is about to save, from its OWN reading of the request:
 * the rows it re-read, its `columnProposals` under a header row (a mapping is saved only there), and
 * the remembered row this save replaces. Nothing here is read from the form (ASVS v5.0.0-8.3.1).
 */
export function columnMappingLayers(
	rows: ParsedCsvRow[],
	headers: readonly string[],
	mapping: ColumnMappingInput,
	remembered: Parameters<typeof storedLayers>[0] | null
): ColumnMappingLayers {
	const posted = designationAssignment(mapping, headers);
	const detected = columnProposals(rows, true).designated;
	const kept = remembered === null ? null : designationAssignment(remembered, headers);
	const keptLayers = remembered === null ? UNKNOWN_LAYERS : storedLayers(remembered);
	const layers: ColumnMappingLayers = { ...UNKNOWN_LAYERS };
	for (const role of Object.keys(FIELD) as MappingRole[]) {
		layers[FIELD[role]] = layerAtSave({
			posted: posted[role],
			detected: detected[role],
			remembered:
				kept === null || remembered === null
					? null
					: { index: kept[role], layer: keptLayers[FIELD[role]] }
		});
	}
	return layers;
}
