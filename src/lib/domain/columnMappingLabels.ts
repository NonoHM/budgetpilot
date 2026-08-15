import * as m from '$lib/paraglide/messages';
import type { MappingRole } from './mappingRoles';

/**
 * The four role labels, in ONE place, because two components render them and a third will.
 *
 * `RoleRow` prints a role as the row's own name; `ColumnCard` prints it inside « Actuellement :
 * Date » and inside the composed accessible label; the picker's title asks « Quelle colonne porte
 * le montant ? ». A second spelling of any of them is a defect nobody can see from inside either
 * component, because each is right about its own copy.
 *
 * The type comes from the server model rather than being restated here. `import type` is erased
 * before the client graph exists, and the alternative, a second literal union, is exactly the
 * two-predicates-agreeing shape this repository has been caught by: the closed set is closed in one
 * place or it is not closed.
 */
const ROLE_LABELS: Record<MappingRole, () => string> = {
	date: m.import_columns_role_date,
	label: m.import_columns_role_label,
	amount: m.import_columns_role_amount,
	category: m.import_columns_role_category
};

/** Translated row label for a mapping role. The role code itself is never shown. */
export function roleLabel(role: MappingRole): string {
	return ROLE_LABELS[role]();
}

/**
 * An example value as a screen reader should hear it.
 *
 * The plate is specific: « exemple moins 24,90 », and it says why in the negative, that `-` must
 * read "moins" and never "tiret". It is not a hypothetical. A statement's amounts are mostly
 * negative, so the sign is the single most repeated character on this screen, and a reader hearing
 * "tiret vingt-quatre virgule quatre-vingt-dix" has been told the punctuation rather than the
 * quantity.
 *
 * Both spellings are folded, the ASCII hyphen and U+2212 MINUS SIGN, because which one arrives is
 * decided by the user's bank rather than by us.
 */
export function spokenExample(value: string): string {
	const trimmed = value.trim();
	if (trimmed === '') return m.import_columns_card_empty_value();
	const sign = trimmed[0];
	if (sign !== '-' && sign !== '−') return trimmed;
	return `${m.import_columns_spoken_minus()} ${trimmed.slice(1).trim()}`;
}
