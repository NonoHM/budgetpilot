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

/**
 * The repository's plural convention, applied in ONE place per sentence.
 *
 * `n > 1 ? many : one`, the same rule `categories/+page.svelte` selects with. No inlang selector or
 * variant: no message in either catalogue uses one, and this is not the change that introduces the
 * first. The comparison is `> 1` rather than `!== 1` because French takes the singular at zero too,
 * and every sentence here that could reach zero omits itself instead (see `ignoredSentence`).
 */
function plural(
	n: number,
	one: (a: { count: number }) => string,
	many: (a: { count: number }) => string
): string {
	return n > 1 ? many({ count: n }) : one({ count: n });
}

/**
 * « Importer 132 lignes », the primary's own label.
 *
 * The fifth plural site, and the one found by LOOKING rather than by grepping: the four others were
 * found by reading the catalogue, this one appeared in a verification screenshot of a one-row file
 * reading « Importer 1 lignes ». A one-row statement is not exotic, and this label is the largest
 * text on the screen.
 */
export function submitLabel(rows: number): string {
	return plural(rows, m.import_columns_submit_one, m.import_columns_submit_many);
}

/**
 * « 3 colonnes · 132 lignes · en-têtes détectés », composed once for both breakpoints.
 *
 * Lives here rather than in the screen for the reason the module comment gives: the screen renders
 * what this returns and composes nothing itself. The screen prints this line TWICE, once in the
 * 390 file block and once in the 1280 heading, and two ternaries would be two places that can be
 * right about their own version of the plural.
 */
export function fileMetaLine(input: { columns: number; rows: number; headers: string }): string {
	return m.import_columns_file_meta({
		columns: plural(
			input.columns,
			m.import_columns_file_meta_columns_one,
			m.import_columns_file_meta_columns_many
		),
		rows: plural(
			input.rows,
			m.import_columns_file_meta_rows_one,
			m.import_columns_file_meta_rows_many
		),
		headers: input.headers
	});
}

/**
 * « 2 colonnes seront ignorées. », or NOTHING at zero.
 *
 * Zero is special and the emptiness is the point: « 0 colonnes seront ignorées » is the absence of
 * information dressed as information, and a three-column file with all three required roles
 * designated reaches it. Omitting the clause is also what keeps English correct at zero without a
 * selector, since "0 column will be ignored" is what the singular branch would have produced.
 */
function ignoredSentence(ignored: number): string {
	if (ignored === 0) return '';
	return ignored > 1
		? m.import_columns_banner_ignored_many({ ignored })
		: m.import_columns_banner_ignored_one({ ignored });
}

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

	// THE `analysing` BRANCH IS GONE with the state that fed it (Planche 5f). It drew brique 9's
	// skeleton on a screen whose cards exist because the file is already read in memory, so there is
	// no instant at which the structure is known and the content absent, and no route ever set it.
	// The skeleton now lives at `/imports` on arrival, which is a server write followed by a re-read.

	if (input.state === 'tooFewColumns') {
		return {
			label: plural(
				input.columnCount,
				m.import_columns_banner_too_few_label_one,
				m.import_columns_banner_too_few_label_many
			),
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
		// Two sentences, joined by a space, and the second is absent at zero. The category clause
		// carries no count and always speaks; the ignored clause carries the count and speaks only
		// when there is something to report.
		const category =
			input.assignment.category !== null
				? m.import_columns_banner_complete_with_category()
				: m.import_columns_banner_complete_without_category();
		const ignoredClause = ignoredSentence(ignored);
		return {
			label: m.import_columns_banner_complete_label(),
			count: m.import_columns_banner_count({ n: designated }),
			consequence: submitting
				? m.import_columns_banner_submitting_consequence()
				: ignoredClause === ''
					? category
					: `${category} ${ignoredClause}`,
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
