import { describe, expect, it } from 'vitest';
import { REQUIRED_COLUMN_ALIASES, REQUIRED_ROLES, resolveRequiredColumns } from './columnAliases';

describe('resolveRequiredColumns', () => {
	it('resolves the three roles from a header row, and says which column filled each', () => {
		// The presence half. Every absence assertion below would pass on a resolver that
		// returned nothing at all.
		const result = resolveRequiredColumns(['dateop', 'label', 'amount', 'category']);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.columns).toStrictEqual({ date: 'dateop', label: 'label', amount: 'amount' });
	});

	it('is decided by the table order, never by the order the columns appear in the file', () => {
		// The same two headers in both orders must give the same answer, because a bank
		// reordering its export is not a change in what the file means.
		const a = resolveRequiredColumns(['booking date', 'started date', 'label', 'amount']);
		const b = resolveRequiredColumns(['started date', 'booking date', 'label', 'amount']);

		// Both are ambiguous, and identically so: THAT is the order independence being pinned.
		expect(a.ok).toBe(false);
		expect(b.ok).toBe(false);
		if (a.ok || b.ok) return;
		expect(a.role).toBe(b.role);
		expect([...a.headers].sort()).toStrictEqual([...b.headers].sort());
	});

	it('refuses when two headers claim one role, and names BOTH of them', () => {
		const result = resolveRequiredColumns(['dateop', 'date', 'label', 'amount']);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.role).toBe('date');
		// Naming one would send the user to look at half the problem.
		expect([...result.headers].sort()).toStrictEqual(['date', 'dateop']);
	});

	it('leaves a role undefined when the file has none of its spellings', () => {
		const result = resolveRequiredColumns(['date', 'libelle', 'debit', 'credit']);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.columns.amount).toBeUndefined();
		// And the roles it CAN fill are still filled, so an absent amount is not read as a
		// resolver that gave up.
		expect(result.columns.date).toBe('date');
		expect(result.columns.label).toBe('libelle');
	});

	it('matches case insensitively and ignores surrounding whitespace', () => {
		const result = resolveRequiredColumns(['  Booking Date ', 'Partner Name', 'Amount (EUR)']);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.columns).toStrictEqual({
			date: 'booking date',
			label: 'partner name',
			amount: 'amount (eur)'
		});
	});

	it('does not resolve Chase’s posting date, and that absence is a decision', () => {
		// Chase writes 08/01/2026 meaning 1 August, and normalizeDate reads dd/mm, so adding
		// this alias imports the row dated 8 January. Date ORDER is a per file property an
		// alias table cannot express. This test exists so the alias is not added as an
		// obvious omission.
		const result = resolveRequiredColumns(['details', 'posting date', 'description', 'amount']);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.columns.date).toBeUndefined();
		// The control: the OTHER two roles in that same header row do resolve, so the
		// undefined date is the table refusing one alias rather than the resolver failing.
		expect(result.columns.label).toBe('description');
		expect(result.columns.amount).toBe('amount');
	});
});

describe('the alias table itself', () => {
	it('lists the canonical spelling first for every role', () => {
		expect(REQUIRED_COLUMN_ALIASES.date[0]).toBe('date');
		expect(REQUIRED_COLUMN_ALIASES.label[0]).toBe('label');
		expect(REQUIRED_COLUMN_ALIASES.amount[0]).toBe('amount');
	});

	it('holds no duplicate spelling within a role or across roles', () => {
		// A spelling in two roles would make one file resolve two different roles from one
		// column, which the collision rule cannot see because it looks per role.
		const all = REQUIRED_ROLES.flatMap((role) => [...REQUIRED_COLUMN_ALIASES[role]]);

		expect(all.length).toBeGreaterThan(0);
		expect(new Set(all).size).toBe(all.length);
	});

	it.each(REQUIRED_ROLES.flatMap((role) => REQUIRED_COLUMN_ALIASES[role].map((a) => [role, a])))(
		'every spelling in the table actually resolves: %s <- %s',
		(role, alias) => {
			// Found by break checking one alias at a time against the real headers: removing
			// `montant` reddened NOTHING, because no fixture file uses it. An alias nothing
			// exercises is indistinguishable from one that is misspelt, and the table is the
			// only place that could tell you.
			const result = resolveRequiredColumns([alias as string]);

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.columns[role as keyof typeof result.columns]).toBe(alias);
		}
	);

	it('is entirely lowercase and untrimmed-free, because lookup normalises the header', () => {
		const all = REQUIRED_ROLES.flatMap((role) => [...REQUIRED_COLUMN_ALIASES[role]]);

		// An entry with a capital or a stray space can never match, and nothing else would
		// report it: the file would simply fail to resolve and read as an unsupported bank.
		expect(all.filter((alias) => alias !== alias.trim().toLowerCase())).toStrictEqual([]);
		// 12: five date spellings, four label, three amount. Exact rather than a floor, so
		// adding a spelling is a deliberate edit here and gets checked against the real
		// headers fixture for a collision.
		//
		// THIS IS THE ONLY TEST THAT SEES A DELETION, and the division of labour is worth
		// stating. The per alias test above is GENERATED FROM the table, so removing an entry
		// simply removes its case and it stays green: a test built from its own subject cannot
		// notice the subject shrinking. That one catches a misspelt alias, one that could never
		// match anything. This one catches a missing alias. Neither covers the other.
		expect(all).toHaveLength(12);
	});
});
