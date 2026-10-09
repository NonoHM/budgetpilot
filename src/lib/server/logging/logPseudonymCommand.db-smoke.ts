import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import { logUserPseudonym } from './pseudonym';

/**
 * #942, against a real engine: `scripts/log-pseudonym.mjs --email` prints the user pseudonym the app
 * writes into its log for that account, and `--user` turns it back into the account's email. The
 * expected value is `pseudonym.ts`'s `logUserPseudonym`, the function `authn.ts` calls, never the
 * derivation called a second way. The command is a child `node` with the suite's own
 * `DATABASE_PROVIDER` and `DATABASE_URL`, so it reads the database this suite writes, through
 * `createPrismaClient` as the app does.
 *
 * The secret is an explicit fixture here: `vitest.db.env-stub.ts` is empty on purpose.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/log-pseudonym.mjs');
const SECRET = 'c3'.repeat(32);
const created: string[] = [];

const saved = env.RATE_LIMIT_HASH_SECRET;
afterEach(() => {
	env.RATE_LIMIT_HASH_SECRET = saved;
});

afterAll(async () => {
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

// `--email` reads the address from stdin, never argv, which /proc and shell history keep.
function run(args: string[], input?: string, databaseUrl = process.env.DATABASE_URL) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		input,
		env: {
			PATH: process.env.PATH,
			DATABASE_PROVIDER: process.env.DATABASE_PROVIDER,
			DATABASE_URL: databaseUrl,
			RATE_LIMIT_HASH_SECRET: SECRET
		},
		encoding: 'utf8',
		timeout: 60_000
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function createUser(local = 'log-pseudonym') {
	const email = `${local}-${randomUUID()}@budgetpilot.invalid`;
	const user = await prisma.user.create({
		data: { email, passwordHash: 'not-a-hash' },
		select: { id: true, email: true }
	});
	created.push(user.id);
	return user;
}

describe('log-pseudonym on an account', () => {
	it('prints the user pseudonym the app logs for an email, and nothing else', async () => {
		const user = await createUser();
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--email'], `${user.email}\n`);
		expect(out.stderr).toBe('');
		expect(out.status).toBe(0);
		expect(out.stdout).toBe(`${logUserPseudonym(user.id)}\n`);
	});

	// Separates a command that normalises the email as sign-in does from one that looks up the text
	// as typed: the stored form is lowercase and trimmed.
	it('finds the account from the email as an operator may type it', async () => {
		const user = await createUser();
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--email'], `  ${user.email.toUpperCase()} \n`);
		expect(out.stdout).toBe(`${logUserPseudonym(user.id)}\n`);
	});

	// Separates sign-in's check (`validateEmail`) from registration's ASCII-only one: an account
	// registered before that rule must stay reachable, as it does at sign-in.
	it('finds an account whose email is not ASCII', async () => {
		const user = await createUser('café');
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--email'], `${user.email}\n`);
		expect(out.stderr).toBe('');
		expect(out.stdout).toBe(`${logUserPseudonym(user.id)}\n`);
	});

	it('turns the logged pseudonym back into the account email, and nothing else', async () => {
		const user = await createUser();
		// A second account, so a command answering with the first or the last row is caught.
		await createUser();
		env.RATE_LIMIT_HASH_SECRET = SECRET;
		const out = run(['--user', logUserPseudonym(user.id).toUpperCase()]);
		expect(out.stderr).toBe('');
		expect(out.status).toBe(0);
		expect(out.stdout).toBe(`${user.email}\n`);
	});

	it('says that no account matches a pseudonym no row produces', async () => {
		await createUser();
		const out = run(['--user', randomBytes(32).toString('hex')]);
		expect(out.status).toBe(1);
		expect(out.stdout).toBe('');
		expect(out.stderr).toMatch(/^No account has this pseudonym under the current secret\./);
	});

	// Separates « no account matched » from « the database could not be read »: a command that caught
	// every error as a miss would answer an operator's question wrongly while looking right. The
	// MariaDB driver gives up on an unreachable server after its 20-second pool timeout, per run.
	it('reports a database it cannot read as a failure, never as no account', () => {
		const provider = process.env.DATABASE_PROVIDER ?? 'sqlite';
		const unreachable =
			provider === 'sqlite'
				? 'file:/nonexistent-942/directory/smoke.db'
				: `${provider === 'mysql' ? 'mysql' : 'postgresql'}://nobody:nothing@127.0.0.1:1/none`;
		for (const args of [['--user', 'ab'.repeat(32)], ['--email']]) {
			const out = run(args, 'someone@budgetpilot.invalid\n', unreachable);
			expect(out.status).toBe(2);
			expect(out.stdout).toBe('');
			expect(out.stderr).toMatch(/^The database could not be read: /);
		}
	}, 120_000);

	it('says that no account has an email that was never registered', () => {
		const out = run(['--email'], `nobody-${randomUUID()}@budgetpilot.invalid\n`);
		expect(out.status).toBe(1);
		expect(out.stdout).toBe('');
		expect(out.stderr).toBe('No account has this email.\n');
	});
});
