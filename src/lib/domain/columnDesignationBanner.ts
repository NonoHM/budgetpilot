import * as m from '$lib/paraglide/messages';
import type { MappingRole } from './mappingRoles';
import {
	designatedRequiredCount,
	ignoredColumnCount,
	missingRequiredRoles,
	type DesignationPageState,
	type RoleAssignment
} from './columnDesignation';

/**
 * The condition banner's four values, one function, all fourteen page states.
 *
 * Separate from `columnDesignation.ts` so the state machine stays free of i18n, the same split
 * `natureLabels.ts` has from `transaction.ts`. The screen renders what this returns and composes
 * nothing itself: a second place that builds this copy is a second place that can be right about
 * its own version.
 *
 * Every string here is COPIED from the design handoff's state table, never composed from a
 * sentence that reads similarly. Where the plate gives a figure it is interpolated; where it gives
 * words they are the plate's words.
 */
export interface BannerCopy {
	label: string;
	count: string;
	consequence: string;
	complete: boolean;
}

/**
 * The missing roles as a French list with their articles: « la date et le montant ».
 *
 * The articles are per role and gendered, which is why they live in the catalogue as whole
 * fragments rather than being assembled from a role name and an article: « le date » is what
 * assembling produces, and no test that checks for the role name would see it.
 */
const MISSING_ROLE_LABELS: Record<'date' | 'label' | 'amount', () => string> = {
	date: m.import_columns_missing_date,
	label: m.import_columns_missing_label,
	amount: m.import_columns_missing_amount
};

export function missingRolesSentence(roles: readonly MappingRole[]): string {
	const parts = roles
		.filter((role): role is 'date' | 'label' | 'amount' => role in MISSING_ROLE_LABELS)
		.map((role) => MISSING_ROLE_LABELS[role]());

	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	// « la date, le libellé et le montant »: a comma between all but the last pair, then the
	// conjunction. Never a trailing serial comma, which French does not take.
	const head = parts.slice(0, -1).join(', ');
	return `${head} ${m.import_columns_missing_join()} ${parts[parts.length - 1]}`;
}

export function bannerFor(input: {
	state: DesignationPageState;
	assignment: RoleAssignment;
	columnCount: number;
	/** Per role, how many columns detection thinks could carry it. Only >= 2 reaches the copy. */
	candidateCounts?: Partial<Record<MappingRole, number>>;
	/** State 3b only: how many remembered columns are gone from the new file. */
	lostCount?: number;
}): BannerCopy {
	const designated = designatedRequiredCount(input.assignment);
	const count = m.import_columns_banner_count({ n: designated });

	if (input.state === 'analysing') {
		return {
			label: m.import_columns_banner_analysing_label(),
			// A bare placeholder glyph rather than a zero: no count has been read yet, and `0 sur 3`
			// would be a measurement the screen has not taken.
			count: m.import_columns_banner_analysing_count(),
			consequence: m.import_columns_banner_analysing_consequence(),
			complete: false
		};
	}

	if (input.state === 'tooFewColumns') {
		return {
			label: m.import_columns_banner_too_few_label({ count: input.columnCount }),
			count: m.import_columns_banner_count({ n: 0 }),
			consequence: m.import_columns_banner_too_few_consequence(),
			complete: false
		};
	}

	if (input.state === 'signaturePartial') {
		const lost = input.lostCount ?? 1;
		const label =
			lost >= 3
				? m.import_columns_banner_redesignate_three()
				: lost === 2
					? m.import_columns_banner_redesignate_two()
					: m.import_columns_banner_redesignate_one();
		return {
			label,
			count,
			consequence: m.import_columns_banner_redesignate_consequence({ columns: input.columnCount }),
			complete: false
		};
	}

	// `submitting` changes ONLY line 2. Line 1 and the count stay exactly as they were, because the
	// import is running against the state the user just confirmed and redrawing it would suggest
	// something had changed at the moment they can no longer act on it.
	const submitting = input.state === 'submitting';
	const complete = submitting || input.state === 'complete';

	if (complete) {
		const ignored = ignoredColumnCount(input.assignment, input.columnCount);
		return {
			label: m.import_columns_banner_complete_label(),
			count: m.import_columns_banner_count({ n: designated }),
			consequence: submitting
				? m.import_columns_banner_submitting_consequence()
				: input.assignment.category !== null
					? m.import_columns_banner_complete_with_category({ ignored })
					: m.import_columns_banner_complete_without_category({ ignored }),
			// The check glyph is BLACK. This is the state of a condition, not the result of an action.
			complete: true
		};
	}

	const missing = missingRequiredRoles(input.assignment);
	if (missing.length === 0 || input.state === 'nothingDesignated') {
		return {
			label: m.import_columns_banner_todo_label(),
			count,
			consequence: m.import_columns_banner_zero_consequence(),
			complete: false
		};
	}

	// Ambiguity is reported for the FIRST missing role in row order that has candidates, not for all
	// of them. The plate's sentence carries one clause, and a sentence naming two ambiguities is one
	// the reader has to parse rather than act on.
	const ambiguous = missing.find((role) => (input.candidateCounts?.[role] ?? 0) >= 2);
	const roles = missingRolesSentence(missing);

	return {
		label: m.import_columns_banner_todo_label(),
		count,
		consequence: ambiguous
			? m.import_columns_banner_remaining_candidates({
					roles,
					count: input.candidateCounts?.[ambiguous] ?? 0
				})
			: m.import_columns_banner_remaining({ roles }),
		complete: false
	};
}
