import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';

/**
 * The per-address limiter against a real engine, through the real `/register?invite=` action: a
 * client rotating its IPv6 address inside the prefix it was given is ONE client.
 *
 * The invitation door is keyed by address alone, so it is where rotation buys the most: every
 * address in a /64 is a fresh counter when the key is the full address. Five wrong invitation
 * tokens from five addresses of one /56 must leave the sixth refused, and a sixth from the
 * neighbouring /56 must not be: the second half is the calibration, without which a limiter that
 * refused everyone would pass the first.
 *
 * Each run draws its own /48s inside 2001:db8::/32 (documentation, RFC 3849), so a rerun inside the
 * 15-minute window meets no row from the last one, except by a 1 in 32768 draw.
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

const startedAt = new Date();

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'b7'.repeat(32);
});

afterAll(async () => {
	await prisma.loginAttempt.deleteMany({
		where: { kind: 'INVITE', createdAt: { gte: startedAt } }
	});
});

async function postInvite(address: string): Promise<number | undefined> {
	const { actions } = await import('./+page.server');
	const action = actions.default as unknown as (event: unknown) => Promise<unknown>;
	const result = (await action({
		cookies: { get: () => undefined, set: () => {} },
		getClientAddress: () => address,
		locals: {},
		request: new Request('http://localhost/register?invite=not-a-token', {
			method: 'POST',
			body: new FormData()
		}),
		url: new URL('http://localhost/register?invite=not-a-token')
	})) as { status?: number };
	return result.status;
}

/** Five wrong tokens from five addresses spread across one /56 (fourth group 0x5600 to 0x5644). */
async function spendFrom(site: string): Promise<(number | undefined)[]> {
	const statuses = [];
	for (let i = 0; i < 5; i += 1) {
		statuses.push(
			await postInvite(`${site}:56${(i * 0x11).toString(16).padStart(2, '0')}::${i + 1}`)
		);
	}
	return statuses;
}

/** Two neighbouring /48s per run, one per test, so neither test's rows reach the other's counter. */
const firstSite = randomInt(0, 0x7fff) * 2;
function siteOf(offset: 0 | 1): string {
	return `2001:db8:${(firstSite + offset).toString(16)}`;
}

// Two tests, not one: a refusal asserted before the calibration would leave the calibration
// unevaluated whenever the refusal is red.
describe('the invitation door counts an IPv6 client by its /56', () => {
	it('a sixth address inside the same /56 is refused', async () => {
		const site = siteOf(0);
		// Each of the five reached the token check and was told the token is invalid.
		expect(await spendFrom(site)).toEqual([410, 410, 410, 410, 410]);
		expect(await postInvite(`${site}:56ff:abcd::6`)).toBe(429);
	});

	it('the neighbouring /56 is another subscriber and keeps its own budget', async () => {
		const site = siteOf(1);
		expect(await spendFrom(site)).toEqual([410, 410, 410, 410, 410]);
		expect(await postInvite(`${site}:5700::6`)).toBe(410);
	});
});
