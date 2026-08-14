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
 * `08/01/2026` is 1 August at source, and `normalizeDate` reads `dd/mm`, so this row would
 * import dated 8 January. **A file that imports with a wrong date is worse than the refusal it
 * replaces.** Date ORDER is a per file property an alias table structurally cannot express, so
 * Chase is unblocked by the mapping path (#301), never by adding `posting date` to the date
 * aliases. DO NOT ADD THAT ALIAS.
 *
 * Note it is refused by ABSENCE, not by the collision rule: Chase carries one date column.
 */
export const CHASE: [string, string] = [
	'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
	'DEBIT,08/01/2026,WHOLE FOODS,-52.11,ACCT_XFER,1200.00,'
];
