#!/usr/bin/env node
/**
 * Turns a log pseudonym back into what it names, or a value into its pseudonym (#942).
 *
 *   docker compose exec budgetpilot /nodejs/bin/node scripts/log-pseudonym.mjs --email
 *   docker compose exec -T budgetpilot /nodejs/bin/node scripts/log-pseudonym.mjs --user <pseudonym>
 *   docker compose exec -T budgetpilot /nodejs/bin/node scripts/log-pseudonym.mjs --address <ip>
 *   docker compose exec -T budgetpilot /nodejs/bin/node scripts/log-pseudonym.mjs --subnet <ip> --prefix <n>
 *
 * It imports the very modules the app hashes with, under the secret read by the app's own reader,
 * so what it prints is what the app logged; a copy of the derivation (another label, the raw secret
 * instead of the derived key) would match nothing, silently. docs/logging.md, « The client address
 * and the account », is the operator's page for it.
 *
 * `--email` reads the address from standard input and refuses one written after the flag: the
 * command line is visible to `ps` and kept in shell history (CWE-214), and the email is the one
 * value the log hides by design. A pseudonym is opaque, and an address is already in the proxy's
 * own log, so those two are arguments.
 *
 * One value on stdout and nothing else. Exit status as POSIX grep's: 0 found, 1 no account, 2 a
 * refusal or a failure, each with its reason on stderr. All imports are static, so a module missing
 * from the image fails every mode at load, not only the one that would have reached it.
 */
import process from 'node:process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { validateEmail } from '../src/lib/server/auth/emailAddress.ts';
import { readRateLimitSecret } from '../src/lib/server/auth/rateLimitSecret.ts';
import { createPrismaClient } from '../src/lib/server/database/client.ts';
import { SETTINGS } from '../src/lib/server/env/settings.ts';
import {
	deriveLogPseudonymKey,
	deriveLogSubnetKey,
	deriveLogUserKey,
	logPseudonymWith,
	logSubnetPseudonymWith,
	logUserPseudonymWith
} from '../src/lib/server/logging/pseudonymDerivation.ts';
import { canonicalIpText } from '../src/lib/server/net/clientAddress.ts';

const FOUND = 0;
const NO_ACCOUNT = 1;
const REFUSED = 2;

const USAGE = `Usage: log-pseudonym.mjs <mode>
  --email                     read an email from standard input, print its user pseudonym
  --user <pseudonym>          print the email of the account with this user pseudonym
  --address <ip>              print the client pseudonym of this address
  --subnet <ip> --prefix <n>  print the subnet label at the width the log line carries`;

/** A reason the command stops, written for the operator. */
class Refusal extends Error {
	/** @param {string} message @param {number} [status] */
	constructor(message, status = REFUSED) {
		super(message);
		this.status = status;
	}
}

function parse() {
	let parsed;
	try {
		parsed = parseArgs({
			allowPositionals: true,
			options: {
				email: { type: 'boolean' },
				user: { type: 'string' },
				address: { type: 'string' },
				subnet: { type: 'string' },
				prefix: { type: 'string' }
			}
		});
	} catch {
		throw new Refusal(USAGE);
	}
	const { values, positionals } = parsed;
	const modes = ['email', 'user', 'address', 'subnet'].filter((mode) => values[mode] !== undefined);
	if (values.email && positionals.length > 0) {
		throw new Refusal(
			'--email reads the email from standard input, never from the command line, which ps and ' +
				'shell history keep.'
		);
	}
	if (modes.length !== 1 || positionals.length > 0) throw new Refusal(USAGE);
	if (values.prefix !== undefined && modes[0] !== 'subnet') throw new Refusal(USAGE);
	return { mode: modes[0], values };
}

/** @param {string} value */
function requireAddress(value, flag) {
	if (canonicalIpText(value) === null) {
		throw new Refusal(`The value given to ${flag} is not an IP address.`);
	}
	return value;
}

/** The width the log line carries, within the bounds the setting itself accepts. */
function requirePrefix(text) {
	const { min, max } = SETTINGS.BP_RATE_LIMIT_IPV6_PREFIX;
	if (text === undefined) {
		throw new Refusal(
			'--subnet needs --prefix: the width the log line carries in ' +
				'budgetpilot.client.subnet_prefix_length.'
		);
	}
	const width = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
	if (!(width >= min && width <= max)) {
		throw new Refusal(`--prefix must be a whole number between ${min} and ${max}.`);
	}
	return width;
}

/** @param {string} text */
function requireUserPseudonym(text) {
	if (!/^[0-9a-fA-F]{64}$/.test(text)) {
		throw new Refusal('A user pseudonym is 64 hexadecimal characters; this value is not one.');
	}
	return text.toLowerCase();
}

function secret() {
	try {
		return readRateLimitSecret(process.env);
	} catch (error) {
		throw new Refusal(error instanceof Error ? error.message : String(error));
	}
}

/** The first line of standard input, prompting only when a person is typing it. */
async function readEmail() {
	const interactive = Boolean(process.stdin.isTTY);
	const lines = createInterface({
		input: process.stdin,
		output: interactive ? process.stderr : undefined,
		terminal: interactive
	});
	if (interactive) process.stderr.write('Email: ');
	let first = null;
	for await (const line of lines) {
		first = line;
		break;
	}
	lines.close();
	if (first === null || first.trim() === '') {
		throw new Refusal('No email was given on standard input.');
	}
	// Sign-in's own check, so what reaches the database is what sign-in would look up: a control
	// character would otherwise fail there and read as an unreadable database.
	const email = validateEmail(first);
	if (email === null) throw new Refusal('That is not an email address an account can have.');
	return email;
}

/**
 * Runs one read against the app's own client. A database that cannot be read is a failure (2),
 * never « no account » (1): that would be a wrong answer that looks right.
 *
 * @template T
 * @param {(prisma: ReturnType<typeof createPrismaClient>) => Promise<T>} read
 * @returns {Promise<T>}
 */
async function withDatabase(read) {
	let prisma;
	try {
		prisma = createPrismaClient();
		return await read(prisma);
	} catch (error) {
		throw new Refusal(
			`The database could not be read: ${error instanceof Error ? error.message : String(error)}`
		);
	} finally {
		await prisma?.$disconnect();
	}
}

async function main() {
	const { mode, values } = parse();

	if (mode === 'address') {
		const address = requireAddress(values.address, '--address');
		return logPseudonymWith(deriveLogPseudonymKey(secret()), address);
	}

	if (mode === 'subnet') {
		const address = requireAddress(values.subnet, '--subnet');
		const width = requirePrefix(values.prefix);
		return logSubnetPseudonymWith(deriveLogSubnetKey(secret()), address, width);
	}

	if (mode === 'user') {
		const wanted = requireUserPseudonym(values.user);
		const key = deriveLogUserKey(secret());
		const users = await withDatabase((prisma) =>
			prisma.user.findMany({ select: { id: true, email: true } })
		);
		const match = users.find((user) => logUserPseudonymWith(key, user.id) === wanted);
		if (!match) {
			throw new Refusal(
				'No account has this pseudonym under the current secret. The line may predate a ' +
					'rotation of RATE_LIMIT_HASH_SECRET, name an account since deleted, or come from ' +
					'another instance.',
				NO_ACCOUNT
			);
		}
		return match.email;
	}

	// The secret first, so a refused secret is said before anyone types an email.
	const key = deriveLogUserKey(secret());
	const email = await readEmail();
	const user = await withDatabase((prisma) =>
		prisma.user.findUnique({ where: { email }, select: { id: true } })
	);
	if (!user) throw new Refusal('No account has this email.', NO_ACCOUNT);
	return logUserPseudonymWith(key, user.id);
}

try {
	process.stdout.write(`${await main()}\n`);
	process.exitCode = FOUND;
} catch (error) {
	// Anything unforeseen is a failure (2). Left uncaught, Node would exit 1, which here means « no
	// account ».
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = error instanceof Refusal ? error.status : REFUSED;
}
