import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Enable Banking application JWT (RS256). Every API call is authenticated with a
 * short-lived token signed by the application's locally-generated private key —
 * there is no per-connection token in this scheme.
 *
 * Secrets discipline: the app id and private key come exclusively from env
 * (ENABLE_BANKING_APP_ID, and ENABLE_BANKING_PRIVATE_KEY OR
 * ENABLE_BANKING_PRIVATE_KEY_PATH — mutually exclusive), are never logged and never
 * appear in error messages (a file PATH may appear in errors; key CONTENT never does).
 */

// Well below the provider's 24h maximum; a token is signed per request batch, not cached.
const JWT_TTL_SECONDS = 3600;
const JWT_ISSUER = 'enablebanking.com';
const JWT_AUDIENCE = 'api.enablebanking.com';

/**
 * The provider credentials are absent, contradictory or unreadable: an OPERATOR configuration
 * fault, not a provider or network one (#524).
 *
 * A distinct type rather than a plain `Error`, and the reason is what #524 measured: three call
 * sites already threw messages naming exactly which variable to set and which paths were tried, and
 * a bare `catch` in the route collapsed all of them into « La liste des banques est indisponible
 * pour le moment. Réessayez plus tard. » Waiting fixes none of these, so the screen was telling the
 * one person who could fix it to do the one thing that cannot.
 *
 * The `message` stays operator-facing and never reaches a user: `$lib/server/errors` recognises the
 * TYPE and hands the interface a code, which the interface turns into its own sentence. That split
 * is what lets the message keep naming the variable without leaking an English internal string into
 * a French screen (#277).
 *
 * Carries no key material by construction: every site below passes a variable name or a path, and
 * the module docstring's rule ("a file PATH may appear in errors; key CONTENT never does") is what
 * bounds it.
 */
export class EnableBankingConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EnableBankingConfigurationError';
	}
}

export interface EnableBankingCredentialsConfig {
	appId: string;
	privateKeyPem: string;
}

/**
 * Reads the Enable Banking app credentials from env. Returns null when unconfigured
 * (callers must translate that into a safe, secret-free error). The private key comes
 * from ENABLE_BANKING_PRIVATE_KEY (inline PEM, literal "\n" sequences supported — the
 * usual way multi-line keys are stored in .env files) or from the file pointed to by
 * ENABLE_BANKING_PRIVATE_KEY_PATH. Setting both is a configuration error (throws):
 * silently preferring one could mask a stale copy of the other.
 */
export function getEnableBankingCredentials(
	env: NodeJS.ProcessEnv = process.env
): EnableBankingCredentialsConfig | null {
	const appId = env.ENABLE_BANKING_APP_ID?.trim();
	const inlineKey = env.ENABLE_BANKING_PRIVATE_KEY?.trim();
	const keyPath = env.ENABLE_BANKING_PRIVATE_KEY_PATH?.trim();

	if (inlineKey && keyPath) {
		throw new EnableBankingConfigurationError(
			'Set either ENABLE_BANKING_PRIVATE_KEY or ENABLE_BANKING_PRIVATE_KEY_PATH, not both'
		);
	}

	const privateKeyPem = keyPath
		? readPrivateKeyFile(keyPath)
		: (inlineKey?.replace(/\\n/g, '\n') ?? '');
	if (!appId || !privateKeyPem) return null;
	return { appId, privateKeyPem };
}

/**
 * Reads the PEM file referenced by ENABLE_BANKING_PRIVATE_KEY_PATH. A relative path is
 * tried against process.cwd() first, then against the project root located by walking
 * up from this module to the nearest package.json — cwd is not guaranteed to be the
 * project root across `npm run dev`, tests, and the Docker runtime. Errors carry the
 * tried paths only, never any file content.
 */
function readPrivateKeyFile(rawPath: string): string {
	const candidates = isAbsolute(rawPath)
		? [rawPath]
		: [...new Set([resolve(process.cwd(), rawPath), resolve(resolveProjectRoot(), rawPath)])];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new EnableBankingConfigurationError(
			`Enable Banking private key file not found (ENABLE_BANKING_PRIVATE_KEY_PATH); tried: ${candidates.join(', ')}`
		);
	}
	return readFileSync(found, 'utf8').trim();
}

/** Nearest ancestor of this module containing a package.json; falls back to cwd. */
function resolveProjectRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		if (existsSync(join(dir, 'package.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return process.cwd();
		dir = parent;
	}
}

/** Signs a fresh application JWT. Throws if the PEM is not a valid PKCS8 RSA key. */
export async function createEnableBankingJwt(
	credentials: EnableBankingCredentialsConfig,
	now: Date = new Date()
): Promise<string> {
	const key = await importPKCS8(credentials.privateKeyPem, 'RS256');
	const issuedAt = Math.floor(now.getTime() / 1000);
	return await new SignJWT({})
		.setProtectedHeader({ typ: 'JWT', alg: 'RS256', kid: credentials.appId })
		.setIssuer(JWT_ISSUER)
		.setAudience(JWT_AUDIENCE)
		.setIssuedAt(issuedAt)
		.setExpirationTime(issuedAt + JWT_TTL_SECONDS)
		.sign(key);
}
