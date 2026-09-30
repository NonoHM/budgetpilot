import { createHmac } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { readOperatorBound } from '$lib/server/env/operatorBound';

const WINDOW_MS = 15 * 60 * 1000;
// REAUTH is deliberately shorter than the 15-minute LOGIN/etc window. Every REAUTH action sits
// BEHIND a valid session (deleteAccount, changePassword, disableTotp, confirmTotpSetup), so the
// limiter is secondary containment, not the front-line gate, and its real job is only to keep a
// session-holder from grinding the password/TOTP unboundedly. Security here is dominated by argon2
// (slow) and the TOTP mechanics (~90s validity in a 10^6 space), so 5 tries per 5-minute sliding
// window loses no protection versus 15 minutes: it only shortens the honest owner's self-inflicted
// lockout. The window is what bounds the "cannot leave the account stuck" guarantee: because only
// FAILED attempts are recorded and the window slides, a tripped counter self-clears in ~5 minutes
// with no admin, so the escape hatch (deleteAccount) always reopens on its own.
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * The import doors carry their own maximum, and it is deliberately far above the authentication one.
 *
 * Five per fifteen minutes is right for a password and wrong for statements. A household importing a
 * year of monthly statements across three accounts uploads roughly three dozen files in one sitting,
 * and a limiter that refuses that has traded a denial of service for a denial of the product. Sixty
 * per fifteen minutes clears any plausible honest batch with room over, and still caps a grinder at
 * four uploads a minute.
 *
 * This is a judgement against a usage figure, not a derivation, and it is written down here so the
 * next person changing it knows which number it was chosen against.
 *
 * It is the DEFAULT of `IMPORT_RATE_LIMIT_MAX_ATTEMPTS`, read by `resolveImportMaxAttempts` below.
 * An operator who sets nothing gets exactly this, so making it configurable changed no install.
 */
export const IMPORT_DEFAULT_MAX_ATTEMPTS = 60;

/**
 * The value above which a configured import limit is REFUSED at boot rather than clamped.
 *
 * WHAT A CEILING ON A RATE LIMITER HAS TO ANSWER is what an attacker gains by retrying. At the
 * import doors the answer is narrow: every door sits behind a session, a refusal says nothing about
 * anyone else's data, and nothing secret is being guessed. The one thing a retry buys is SERVER
 * TIME, so the ceiling is set against time, and the time is already measured next door:
 * `import/zipBounds.ts` records an .xlsx parse holding the only thread for 340 ms at its default
 * bound and 1054 ms at its own ceiling. Nothing serialises imports (#283), so this limiter is the
 * only thing bounding how much of that one account can buy per window.
 *
 *   attempts per 15 min | thread held at 340 ms | thread held at 1054 ms
 *   60 (default)        |  20 s  ( 2 %)         |  63 s  ( 7 %)
 *   240 (ceiling)       |  82 s  ( 9 %)         | 253 s  (28 %)
 *   854                 | 290 s  (32 %)         | 900 s (100 %)
 *
 * 240 keeps the worst case, one account on one address uploading the most expensive file the
 * configuration allows as fast as the limiter permits, to 28 % of the window, so nearly three
 * quarters of the server's time stays with everyone else. Near 854 the same account holds the
 * thread for the whole window, and the limiter stops being an availability control at all. The
 * ceiling is four times the default, which is sixteen uploads a minute, well past any batch a
 * person uploads by hand.
 *
 * Refused rather than clamped for the reason `backup/parseBounds.ts` gives: a security limit an
 * operator can raise is a limit an operator can remove, and a clamp reads as configured while
 * something else is in force.
 */
export const IMPORT_MAX_ATTEMPTS_CEILING = 240;

/**
 * The honest batch the default was chosen against, quoted so the boot warning can say what a
 * lowered limit starts refusing: a year of monthly statements across three accounts.
 */
export const HONEST_IMPORT_BATCH_ATTEMPTS = 36;

export const IMPORT_MAX_ATTEMPTS_ENV = 'IMPORT_RATE_LIMIT_MAX_ATTEMPTS';

/**
 * Reads the configured import limit, or throws. Read per call rather than cached at import, matching
 * `resolveCsvMaxColumns` and `resolveBackupMaxJsonNodes`. It THROWS on a bad value rather than
 * falling back, because a fallback would mean the limit in force is not the one configured.
 */
export function resolveImportMaxAttempts(): number {
	const attempts = readOperatorBound({
		name: IMPORT_MAX_ATTEMPTS_ENV,
		fallback: IMPORT_DEFAULT_MAX_ATTEMPTS,
		purpose:
			'It bounds how many uploads the import pages accept per account, and per address, in 15 minutes.'
	});

	if (attempts > IMPORT_MAX_ATTEMPTS_CEILING) {
		throw new Error(
			`${IMPORT_MAX_ATTEMPTS_ENV}=${attempts} is above the hard ceiling of ${IMPORT_MAX_ATTEMPTS_CEILING}. This is a rate limit on expensive work: at the ceiling, one account uploading the most expensive spreadsheet the configuration allows can already hold the server for about a quarter of every 15 minutes. The value is refused rather than clamped so that a limit you set is the limit that runs. The number and the measurements that chose it are in src/lib/server/auth/rateLimit.ts.`
		);
	}

	return attempts;
}

/**
 * Boot check, called from the boot collector beside the other bounds. Refuses to start on an
 * out-of-range value, and reports any departure from the default in both directions.
 */
export function assertImportRateLimitConfigured(): void {
	const attempts = resolveImportMaxAttempts();
	if (attempts === IMPORT_DEFAULT_MAX_ATTEMPTS) return;

	console.warn(
		`[budgetpilot] ${IMPORT_MAX_ATTEMPTS_ENV}=${attempts} differs from the default of ${IMPORT_DEFAULT_MAX_ATTEMPTS}. It bounds how many uploads the import pages accept per account, and per address, in 15 minutes.`
	);

	if (attempts > IMPORT_DEFAULT_MAX_ATTEMPTS) {
		console.warn(
			`[budgetpilot] ${IMPORT_MAX_ATTEMPTS_ENV} is RAISED above the default, so one account may hold the server for longer than the default allows. The measured costs and what each value buys are in src/lib/server/auth/rateLimit.ts.`
		);
	} else if (attempts < HONEST_IMPORT_BATCH_ATTEMPTS) {
		console.warn(
			`[budgetpilot] ${IMPORT_MAX_ATTEMPTS_ENV} is LOWERED below ${HONEST_IMPORT_BATCH_ATTEMPTS}, a year of monthly statements across three accounts. A household importing its statements in one sitting may now be refused, and is told to wait rather than that a limit was lowered.`
		);
	}
}

// The secret is read lazily rather than at module load. It used to throw from this module's
// top-level body, which is why hooks.server.ts imported it for its side effect alone — and why
// the order in which an operator meets the three secret failures was a property of the production
// chunk graph rather than of the source (source order there was rateLimit then crypto; the
// published image threw TOTP_ENCRYPTION_KEY first). assertRateLimitSecretConfigured is called from
// the boot collector instead, which reports every problem at once. The lazy read keeps the failure
// loud for a direct import that never ran boot: the first hashed key throws with the same message
// rather than silently keying on undefined.
let cachedHashSecret: string | undefined;

function hashSecret(): string {
	if (cachedHashSecret === undefined) {
		assertRateLimitSecretConfigured();
		cachedHashSecret = env.RATE_LIMIT_HASH_SECRET!.trim();
	}
	return cachedHashSecret;
}

// 64 hex characters is not a style preference: this value is used directly as an HMAC-SHA256 key
// in hashRateLimitKey below, so its length IS the key strength (ASVS 5.0 V11.2.3, key size, and
// V11.5.1, entropy). docs/getting-started.md:388 has promised the format since the variable
// existed, `openssl rand -hex 32` at :66 produces it, and nothing enforced it — so
// `RATE_LIMIT_HASH_SECRET=changeme` was accepted and produced a 64-bit key, a security control the
// documentation claimed and the code did not have. Exported for the boot collector and its spec.
export function assertRateLimitSecretConfigured(source: NodeJS.ProcessEnv = env): void {
	const raw = source.RATE_LIMIT_HASH_SECRET?.trim();
	if (!raw) {
		throw new Error(
			'RATE_LIMIT_HASH_SECRET is required: it is the HMAC key that hashes the emails and IP ' +
				'addresses recorded for login rate limiting, so without it the limiter has nothing to ' +
				'key on. Set it to 64 hex characters (generate one with `openssl rand -hex 32`).'
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
		throw new Error(
			`RATE_LIMIT_HASH_SECRET must be exactly 64 hex characters (received ${raw.length}). It is ` +
				'used directly as an HMAC-SHA256 key, so a shorter value is a weaker key rather than a ' +
				'shorter name. Generate one with `openssl rand -hex 32`.'
		);
	}
}

type AttemptKind =
	'LOGIN' | 'REGISTER' | 'INVITE' | 'MFA' | 'BANK_SYNC_START' | 'REAUTH' | 'IMPORT';

function windowMsForKind(kind: AttemptKind): number {
	return kind === 'REAUTH' ? REAUTH_WINDOW_MS : WINDOW_MS;
}

function maxAttemptsForKind(kind: AttemptKind): number {
	return kind === 'IMPORT' ? resolveImportMaxAttempts() : MAX_ATTEMPTS;
}

function hashRateLimitKey(value: string): string {
	return createHmac('sha256', hashSecret()).update(value.trim().toLowerCase()).digest('hex');
}

async function isRateLimited(kind: AttemptKind, ip: string, email?: string): Promise<boolean> {
	const ipHash = hashRateLimitKey(ip);
	const windowStart = new Date(Date.now() - windowMsForKind(kind));
	const checks = [];
	if (email !== undefined) {
		const emailHash = hashRateLimitKey(email);
		checks.push(
			prisma.loginAttempt.count({ where: { emailHash, kind, createdAt: { gte: windowStart } } })
		);
	}
	checks.push(
		prisma.loginAttempt.count({ where: { ipHash, kind, createdAt: { gte: windowStart } } })
	);
	const counts = await Promise.all(checks);
	return counts.some((count) => count >= maxAttemptsForKind(kind));
}

async function recordAttempt(kind: AttemptKind, ip: string, email?: string): Promise<void> {
	const ipHash = hashRateLimitKey(ip);
	const emailHash = email !== undefined ? hashRateLimitKey(email) : null;
	const cleanupBefore = new Date(Date.now() - WINDOW_MS * 4);
	await Promise.all([
		prisma.loginAttempt.create({ data: { emailHash, ipHash, kind } }),
		prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cleanupBefore } } })
	]);
}

export async function isLoginRateLimited(email: string, ip: string): Promise<boolean> {
	return isRateLimited('LOGIN', ip, email);
}

export async function recordFailedLoginAttempt(email: string, ip: string): Promise<void> {
	await recordAttempt('LOGIN', ip, email);
}

export async function isRegisterRateLimited(ip: string): Promise<boolean> {
	return isRateLimited('REGISTER', ip);
}

export async function recordRegisterAttempt(ip: string): Promise<void> {
	await recordAttempt('REGISTER', ip);
}

export async function isInviteRateLimited(ip: string): Promise<boolean> {
	return isRateLimited('INVITE', ip);
}

export async function recordInviteAttempt(ip: string): Promise<void> {
	await recordAttempt('INVITE', ip);
}

// Same mechanism as LOGIN: limited by IP AND by hashed MFA challenge id, so
// an attacker can't bypass the limit by generating a new challenge on every
// attempt (e.g. several valid passwords tried on different accounts from the
// same IP, or challenge spam).
export async function isMfaRateLimited(challengeId: string, ip: string): Promise<boolean> {
	return isRateLimited('MFA', ip, challengeId);
}

export async function recordMfaAttempt(challengeId: string, ip: string): Promise<void> {
	await recordAttempt('MFA', ip, challengeId);
}

// Consent-start actions (start/renew) each trigger an outbound call to the bank
// provider (createConnection). Limited by IP AND by hashed userId, same rationale
// as MFA: an authenticated account can't be used to hammer the provider from a
// single IP, nor from many IPs on a single account.
export async function isBankSyncStartRateLimited(userId: string, ip: string): Promise<boolean> {
	return isRateLimited('BANK_SYNC_START', ip, userId);
}

export async function recordBankSyncStartAttempt(userId: string, ip: string): Promise<void> {
	await recordAttempt('BANK_SYNC_START', ip, userId);
}

// One shared counter for every settings action that re-verifies a secret (deleteAccount,
// changePassword, disableTotp, confirmTotpSetup). Keyed by userId AND IP, same as MFA/BANK_SYNC:
// the userId dimension stops an attacker rotating IPs, the IP dimension stops one address spraying.
// It MUST be shared, not per-action: all four test the same password, so a per-action counter would
// hand an attacker four times the guessing budget. Callers record ONLY on a wrong secret (never on
// a mistyped confirmation phrase or a malformed field), so an honest owner cannot lock themselves
// out by legitimate use, and check the limit BEFORE the expensive verify so a tripped counter
// short-circuits.
export async function isReauthRateLimited(userId: string, ip: string): Promise<boolean> {
	return isRateLimited('REAUTH', ip, userId);
}

export async function recordReauthAttempt(userId: string, ip: string): Promise<void> {
	await recordAttempt('REAUTH', ip, userId);
}

// The import doors: `/import`, `/import/columns` and `/import/accounts`. Keyed by userId AND IP, the
// same shape as BANK_SYNC_START and REAUTH, so neither rotating addresses on one account nor
// spraying accounts from one address buys a higher budget.
//
// Unlike LOGIN, EVERY attempt is recorded rather than only the failures: what is being limited here
// is the RATE of expensive work, and a refused upload costs the same to reach as an accepted one.
export async function isImportRateLimited(userId: string, ip: string): Promise<boolean> {
	return isRateLimited('IMPORT', ip, userId);
}

export async function recordImportAttempt(userId: string, ip: string): Promise<void> {
	await recordAttempt('IMPORT', ip, userId);
}
