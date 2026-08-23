import { prisma } from '$lib/server/db';
import { findDiscriminantColumn } from './discriminant';
import { institutionForSource } from './accountBackfill';
import { prefillAccountName } from '$lib/server/accounts/service';
import { isStatementAccount } from '$lib/domain/account';
import {
	headersOf,
	resolveStatementAccount,
	sourceFingerprintFor,
	type AccountResolution
} from './sourceSignature';
import type { ParsedCsvRow } from './types';

/**
 * What the designation screen's account row needs, computed once on the server.
 *
 * ## Why this exists as a module rather than inline in the route
 *
 * Two call sites build the designation payload on `/import` (the correction branch and the
 * unrecognised-file branch), and they have drifted from each other before: the payload is rebuilt
 * key by key at both, deliberately, so that a field added to one and forgotten at the other reaches
 * the screen as `undefined` and draws nothing. That guard works and it does not stop the two
 * COMPUTATIONS diverging, which is what this module removes.
 *
 * ## The options are the destinations, and archived is not one of them
 *
 * `isStatementAccount` is CALLED rather than its condition retyped. It is an exclusion set, and the
 * asymmetry is the reason it is one: forgetting a connector in an inclusion list hides a real
 * account with no error message, while forgetting one in an exclusion list offers a destination the
 * user can see and correct.
 *
 * An archived account is absent from the panel (6h's last edge case) and keeps the imports it
 * already has. Filtered in the QUERY rather than after it, so the count and the list cannot
 * disagree.
 *
 * ## The count is what tells two accounts at one bank apart
 *
 * `···4417 · 128 transactions` is the option's second line, and 6f is explicit that without it two
 * accounts of one bank are indistinguishable in the control built to separate them. So the count is
 * part of the offer rather than a decoration, and it is read here rather than on the screen, where
 * there is no database.
 */
export interface AccountOfferOption {
	id: string;
	name: string;
	discriminant: string | null;
	transactionCount: number;
}

/**
 * What the memory knows about this shape, when it is the memory that answered.
 *
 * Read HERE and not in `resolveStatementAccount`, whose contract is a ranked answer rather than a
 * report: widening it would make every caller carry figures only the screen needs, and would change
 * a function that already shipped with its own battery. Null whenever the answer did not come from
 * memory, so the screen renders the sentence that is true rather than the one with numbers in it.
 */
export interface AccountMemory {
	useCount: number;
	lastUsedAt: Date | null;
}

export interface AccountOffer {
	options: AccountOfferOption[];
	resolution: AccountResolution;
	memory: AccountMemory | null;
	/**
	 * The name the create sheet opens with, composed HERE from what the file said.
	 *
	 * Composed on the server rather than on the screen for the same reason the memorised sentence's
	 * date is: this is where the file has been read. Sending the two halves separately would put a
	 * second copy of the joining rule in the browser, and a name that becomes a database column may
	 * not be assembled twice.
	 */
	prefillName: string;
}

export async function buildAccountOffer(input: {
	userId: string;
	rows: ParsedCsvRow[];
	/**
	 * The profile's source, when the caller knows it, so the prefill can carry the bank's proper
	 * noun. Absent on the correction branch, which decides before anything is parsed: absent means
	 * « we do not know this bank », not « there is none », and the prefill then carries the fragment
	 * alone rather than a guess.
	 */
	source?: string;
}): Promise<AccountOffer> {
	const accounts = await prisma.account.findMany({
		where: { userId: input.userId, archivedAt: null },
		select: {
			id: true,
			name: true,
			source: true,
			discriminant: true,
			archivedAt: true,
			_count: { select: { transactions: true } }
		},
		orderBy: [{ name: 'asc' }, { id: 'asc' }]
	});
	const destinations = accounts.filter((account) => isStatementAccount(account));
	const resolution = await resolveStatementAccount({
		userId: input.userId,
		rows: input.rows,
		accounts: destinations.map((account) => ({
			id: account.id,
			source: account.source,
			archivedAt: account.archivedAt,
			discriminant: account.discriminant
		}))
	});
	/**
	 * The figures behind « Mémorisé, 3 imports depuis le 15 août », and only when memory is what
	 * answered with a single account. Any other rank has nothing to count: rank 1 read the file
	 * itself, and a rank 3 with several candidates is a question rather than a recollection.
	 */
	const memory =
		resolution.rank === 3 && 'candidates' in resolution && resolution.candidates.length === 1
			? await prisma.importSourceSignature.findFirst({
					where: {
						userId: input.userId,
						fingerprint: sourceFingerprintFor(headersOf(input.rows)),
						accountId: resolution.candidates[0]
					},
					select: { useCount: true, lastUsedAt: true }
				})
			: null;

	/**
	 * Read a second time rather than threaded out of `resolveStatementAccount`, and that is the
	 * cheaper of the two. The resolver returns a RANKED ANSWER, and the fragment survives it only
	 * when exactly one account already holds it, which is precisely the case where nobody is about
	 * to create one. The case the sheet exists for, a fragment no account holds, is the case the
	 * answer has thrown away. `findDiscriminantColumn` is pure over the rows the caller already has.
	 */
	const named = findDiscriminantColumn(input.rows);

	return {
		prefillName: prefillAccountName({
			institution: input.source ? institutionForSource(input.source) : null,
			fragment: named.kind === 'found' ? named.fragment : null
		}),
		options: destinations.map((account) => ({
			id: account.id,
			name: account.name,
			discriminant: account.discriminant ?? null,
			transactionCount: account._count.transactions
		})),
		resolution,
		memory
	};
}
