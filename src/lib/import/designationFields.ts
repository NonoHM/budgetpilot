import type { RoleAssignment } from '$lib/domain/columnDesignation';
import { DESIGNATION_ROLES } from '$lib/domain/mappingRoles';

/**
 * THE ONE WRITER of a designation's role fields onto a form, for every place that posts one to
 * `/import/columns`: the designation screen's submit and the duplicate-statement dialog's
 * « Importer quand même ». Two hand-written loops over the stored four used to do this, and a role
 * added to the screen (#1213's Currency) would have been dropped by whichever one was not edited:
 * the #1213 note pass counted that as a refuted premise before any code.
 *
 * Indices, never names: the server resolves them against ITS own header list.
 *
 * The currency is written only while line 1 is data, because the door reads it only then. An
 * empty currency is posted as `none` when the member DECLINED, and is absent when nobody answered,
 * which the door reads as a question still open. Those two are different payloads on purpose.
 */
export function setDesignationFields(
	body: FormData,
	designation: { assignment: RoleAssignment; hasHeaderRow: boolean; currencyDeclined: boolean }
): void {
	for (const role of DESIGNATION_ROLES) {
		if (role === 'currency' && designation.hasHeaderRow) continue;
		const index = designation.assignment[role];
		if (index !== null) body.set(`${role}Index`, String(index));
	}
	if (
		!designation.hasHeaderRow &&
		designation.assignment.currency === null &&
		designation.currencyDeclined
	)
		body.set('currencyIndex', 'none');
}
