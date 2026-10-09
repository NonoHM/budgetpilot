import { logSignInFailed, type SignInFailure } from '$lib/server/logging/authn';

/**
 * The response header a proxy ban tool reads to tell a refused sign-in from any other answer
 * (#876). The application log names a client only by pseudonym (R1), so blocking happens where the
 * raw address already is: the proxy's access log, which records this header beside it. A status
 * code cannot carry the signal, because the client selects it (`x-sveltekit-action: true` turns
 * every action answer into a 200). No `X-` prefix: RFC 6648.
 *
 * The name and value are a contract with operators' filters (`docs/ban-failed-sign-ins.md`).
 * Changing either breaks every installed filter silently.
 */
export const SIGN_IN_REFUSED_HEADER = 'BudgetPilot-Sign-In';
export const SIGN_IN_REFUSED = 'refused';

type Reason<Step extends SignInFailure['step']> = Extract<SignInFailure, { step: Step }>['reason'];

/**
 * Which refusals carry the header: a refusal of a credential THIS REQUEST sent, so that nobody but
 * its sender can put the mark on a response. Exhaustive by type, so a new reason does not compile
 * until it is classified here.
 *
 * - `superseded` at the password step answers with the invalid-credentials body, so it is marked
 *   like the wrong password it reads as: an absent header would tell the client its password was
 *   right and changed meanwhile (class 2, #854).
 * - `superseded` at the second factor is reached only after a code was ACCEPTED.
 * - `unreadable_secret` (#904) is the server's key, not the client's guess, and a ban outreaches the
 *   limiter: the whole site, the recovery-code path included.
 *
 * A limiter refusal is never marked, and is not in this table: it judges no credential, and the
 * limiter counts a subscriber bucket (an IPv6 /56, or the proxy itself when `TRUSTED_PROXIES` is
 * unset) where the proxy bans one raw address, so a mark there would ban whoever shares the bucket.
 */
const MARKED: { [Step in SignInFailure['step']]: Record<Reason<Step>, boolean> } = {
	password: { unknown_account: true, wrong_password: true, superseded: true },
	second_factor: {
		wrong_code: true,
		reused_code: true,
		wrong_recovery_code: true,
		unrecognised_code: true,
		unreadable_secret: false,
		superseded: false
	}
};

function isMarked(failure: SignInFailure): boolean {
	return failure.step === 'password'
		? MARKED.password[failure.reason]
		: MARKED.second_factor[failure.reason];
}

/**
 * A sign-in step refused a credential: the header when the table above says so, then the security
 * event. One call per refusal, so a logged refusal cannot go unclassified. The header comes first so
 * that it does not depend on the line being written: the pseudonym throws on a value that is not an
 * address, and the proxy holds the raw one.
 */
export function refuseSignIn(
	setHeaders: (headers: Record<string, string>) => void,
	ip: string,
	failure: SignInFailure
): void {
	if (isMarked(failure)) setHeaders({ [SIGN_IN_REFUSED_HEADER]: SIGN_IN_REFUSED });
	logSignInFailed(ip, failure);
}
