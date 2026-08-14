/**
 * Ordered aliases for the three columns a transaction cannot be built without.
 *
 * THIS IS THE COLUMN MAPPING PATH'S FIRST LAYER ARRIVING EARLY, NOT A SHORTCUT. When a
 * mapping UI exists, this table becomes the initial guess the user corrects, which is how
 * Actual Budget's importer is built: infer, correct, remember. Extend it or promote it. Do
 * not delete it as a stopgap.
 *
 * ## The collision rule, and why it REFUSES rather than guesses
 *
 * At most ONE spelling per role may appear in a given file. Two distinct headers claiming the
 * same role is a refusal that names both.
 *
 * The rejected alternative was to keep an ordered preference list and let the first entry
 * present win. It is deterministic, and it still makes an invisible choice about which column
 * holds the user's money, with nowhere to say so: `CsvImportResult.warnings` is declared and
 * read by nobody (#308), so "pick one and tell them" is not implementable today.
 *
 * **Today's refusal is tomorrow's affordance rather than an obstacle to remove.** Two headers
 * claiming one role is exactly the moment a mapping UI asks the user to pick, so the refusal
 * is the honest placeholder for that question, and the same message later becomes "choose
 * which column to use". Nobody should soften this into a guess to make a file import: the
 * guess is the defect, and the refusal is what stops it being silent.
 *
 * ## What that costs, stated rather than discovered
 *
 * **This table can never hold two spellings that co-occur in one real export.** Adding an
 * obvious sibling is how you break a bank that works today: N26 carries both `Booking Date`
 * and `Value Date`, Boursorama both `dateOp` and `dateVal`, Revolut both `Started Date` and
 * `Completed Date`. One of each pair is listed, deliberately.
 *
 * That cost is self enforcing rather than a matter of care: `realHeaders.fixture.ts` runs every
 * known header through this table per file, so adding a colliding sibling turns that bank's
 * test red immediately and names it. Loud beats silent, which is the whole argument for the
 * rule.
 *
 * ## `posting date` is absent on purpose
 *
 * Chase's date column is `Posting Date`, and Chase writes `08/01/2026` meaning 1 August, while
 * `normalizeDate` reads `dd/mm` and would file it as 8 January. **A file that imports with a
 * wrong date is worse than the refusal it replaces.** Date ORDER is a per file property that an
 * alias table structurally cannot express, so Chase is unblocked by the mapping path (#301) and
 * never by adding its alias here. DO NOT ADD `posting date`.
 *
 * Note this is NOT a collision: Chase carries one date column. The collision rule does not
 * derive this exclusion, and an earlier draft claimed it did.
 */
export const REQUIRED_COLUMN_ALIASES = {
	date: ['date', 'dateop', 'started date', 'booking date', 'date operation'],
	// `payment reference` is deliberately absent. N26 carries it ALONGSIDE `Partner Name`, so
	// listing both would collide on every N26 export, and it is the wrong choice anyway: it is
	// usually empty, so a file that resolved its label from it would import blank labels.
	label: ['label', 'libelle', 'description', 'partner name'],
	amount: ['amount', 'montant', 'amount (eur)']
} as const;

export type RequiredRole = keyof typeof REQUIRED_COLUMN_ALIASES;

export const REQUIRED_ROLES = Object.keys(REQUIRED_COLUMN_ALIASES) as RequiredRole[];

export type ColumnResolution =
	| { ok: true; columns: Record<RequiredRole, string | undefined> }
	| { ok: false; role: RequiredRole; headers: string[] };

/**
 * Which header fills each role, or which role two headers are fighting over.
 *
 * Returns the AMBIGUITY rather than resolving it, so the caller refuses with both names. The
 * first ambiguous role wins the report: one clear sentence beats a list, and a file with two
 * ambiguous roles has the same answer either way.
 */
export function resolveRequiredColumns(headers: string[]): ColumnResolution {
	const normalized = headers.map((header) => header.trim().toLowerCase());
	const columns: Record<RequiredRole, string | undefined> = {
		date: undefined,
		label: undefined,
		amount: undefined
	};

	for (const role of REQUIRED_ROLES) {
		// Iterate the ALIASES, never the headers: iterating headers would make the answer depend
		// on the order the bank happens to write its columns in.
		const present = REQUIRED_COLUMN_ALIASES[role].filter((alias) => normalized.includes(alias));
		if (present.length > 1) return { ok: false, role, headers: [...present] };
		columns[role] = present[0];
	}

	return { ok: true, columns };
}
