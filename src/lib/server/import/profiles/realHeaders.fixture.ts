/**
 * Header rows taken from real bank exports, not composed for a test.
 *
 * The figure that matters is how many of them import SOMETHING rather than nothing, asserted
 * per file rather than as a count, so a break that unblocks nothing is distinguishable from
 * one that unblocks the wrong bank. Measured at 0 of 5 before the alias table existed.
 *
 * This fixture is also the guard on the alias table's own maintenance cost. The collision rule
 * means the table can never hold two spellings that co-occur in one real export, and each of
 * these files carries a sibling pair that would collide if the obvious second entry were
 * added: N26 has `Booking Date` beside `Value Date` and `Partner Name` beside `Payment
 * Reference`, Boursorama has `dateOp` beside `dateVal`, Revolut has `Started Date` beside
 * `Completed Date`. Adding any of those siblings turns that bank's test red and names it.
 */
export const REAL_HEADERS: Array<[name: string, header: string, row: string]> = [
	[
		'Revolut EN',
		'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
		'CARD_PAYMENT,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Tesco,-12.30,0.00,EUR,COMPLETED,500.00'
	],
	[
		'N26',
		'"Booking Date","Value Date","Partner Name","Partner Iban","Type","Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"',
		'"2026-08-01","2026-08-01","REWE","DE89370400440532013000","MasterCard Payment","","Main Account","-24.50","","",""'
	],
	[
		'Boursorama',
		'dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance',
		'2026-08-01;2026-08-01;CARTE 01/08 MONOPRIX;Alimentation;Vie quotidienne;MONOPRIX;-32,10;;00012345678;CCJ;1500,00'
	]
];

/**
 * N26's LEGACY export, in its three languages. HEADER ROWS ONLY: nothing here came from a
 * statement, and the specs that read these rows synthesise their values.
 *
 * Kept apart from `REAL_HEADERS` because they are not taken from an export in hand, and because
 * none of them imports on the alias table (`Payee`, `Empfänger`, `Bénéficiaire` are no label
 * alias, and `Datum` is no date alias): `realHeaders.spec.ts` asserts every `REAL_HEADERS` row
 * imports something, which these do not. They reach the parser through the designation screen.
 *
 * Two independent sources, read 2026-09-24, give the same layout and the same meaning:
 * `siddhantgoel/beancount-n26` (`beancount_n26/__init__.py`, `HEADER_FIELDS`) maps each legacy
 * account-number column AND the current `Partner Iban` to one key beside the payee, and Firefly
 * III's `import-configurations` (`de/n26/default.json`) gives the legacy column the role
 * `opposing-iban`. So the third column names the OTHER party, in every language.
 */
export const N26_LEGACY_HEADERS: Array<[name: string, header: string]> = [
	[
		'N26 legacy EN',
		'"Date","Payee","Account number","Transaction type","Payment reference","Category","Amount (EUR)","Amount (Foreign Currency)","Type Foreign Currency","Exchange Rate"'
	],
	[
		'N26 legacy DE',
		'"Datum","Empfänger","Kontonummer","Transaktionstyp","Verwendungszweck","Kategorie","Betrag (EUR)","Betrag (Fremdwährung)","Fremdwährung","Wechselkurs"'
	],
	[
		'N26 legacy FR',
		'"Date","Bénéficiaire","Numéro de compte","Type de transaction","Référence de paiement","Catégorie","Montant (EUR)","Montant (Devise étrangère)","Sélectionnez la devise étrangère","Taux de conversion"'
	]
];

/**
 * Whose account each account-identifier column of a RECORDED header row names, one entry per
 * column, with the reason read from the row or its source.
 *
 * This is the direction the discriminant's own header sets cannot check for themselves: a set can
 * be asked whether each member is recorded, never whether a recorded counterparty column is
 * missing from it. `discriminant.spec.ts` runs every entry through `findDiscriminantColumn` in its
 * own recorded row, so a counterparty column recorded here and not excluded there goes red. What
 * no check here can see is a layout nobody recorded.
 */
export const RECORDED_ACCOUNT_COLUMNS: Array<
	[row: string, header: string, party: 'holder' | 'counterparty']
> = [
	// `Partner` is the other party; the same row carries `Partner Name` and `Account Name`.
	['N26', 'Partner Iban', 'counterparty'],
	// Beside `accountLabel` and `accountbalance`: the account the balance is of.
	['Boursorama', 'accountNum', 'holder'],
	// The sources named on `N26_LEGACY_HEADERS`.
	['N26 legacy EN', 'Account number', 'counterparty'],
	['N26 legacy DE', 'Kontonummer', 'counterparty'],
	['N26 legacy FR', 'Numéro de compte', 'counterparty']
];

/**
 * Asserted as STILL REFUSED. It carries a debit/credit PAIR rather than one signed amount, and
 * collapsing that needs a stated sign rule which is deliberately deferred: which column is
 * negative is a per bank convention, and guessing it imports every expense as income or the
 * reverse. Refused with `missing-required-column` naming `amount`, which is true.
 */
export const CREDIT_AGRICOLE: [string, string] = [
	'Date;Libelle;Debit;Credit',
	'01/08/2026;PAIEMENT CB CARREFOUR;-45,20;'
];

/**
 * Asserted as STILL REFUSED, for a different reason, and the difference is the point.
 *
 * `08/01/2026` is 1 August at source, and `normalizeDate` reads `dd/mm` by default, so this row
 * would import dated 8 January. **A file that imports with a wrong date is worse than the refusal
 * it replaces.** Date ORDER is a per file property an alias table structurally cannot express, so
 * it is never unblocked by adding an alias here. DO NOT ADD `posting date`.
 *
 * ## THE ESCAPE ROUTE THIS PARAGRAPH NAMED WAS FALSE, AND IT SURVIVED BECAUSE THE OTHER HALF WAS
 * TRUE
 *
 * It used to end « so Chase is unblocked by the mapping path (#301) ». A designation says WHICH
 * column holds the date and nothing about how the value in it reads, and `mapped` funnelled into
 * the same `normalizeDate` as every other profile, so a designated Chase file imported five
 * months early with nothing said. `columnAliases.ts` was corrected when that was measured and
 * THIS COPY WAS NOT, which is the eighth instance of the rule about comments asserting what a
 * later change made false. The reason it survived is the rule's own prediction: the DO-NOT-ADD
 * half is load-bearing and true, so nobody re-read the sentence beside it.
 *
 * What is true now, after #613: the order is DERIVED from the whole date column at the single
 * door, on every path including `mapped`, so a Chase file carrying any day above the twelfth
 * resolves month-first and imports correctly through a designation. A Chase file whose every cell
 * is ambiguous still does not, and waits on the question screen. Refused here either way, for
 * want of an alias.
 *
 * Note it is refused by ABSENCE, not by the collision rule: Chase carries one date column.
 */
export const CHASE: [string, string] = [
	'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
	'DEBIT,08/01/2026,WHOLE FOODS,-52.11,ACCT_XFER,1200.00,'
];
