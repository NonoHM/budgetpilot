import { env } from '$env/dynamic/private';
import { BACKFILL_USER_EMAIL, BACKFILL_USER_ID } from '$lib/server/auth';
import { prisma } from '$lib/server/db';

// Fail-safe: any missing or unknown value falls back to "admin_only" (never an
// implicit opening of public registration on an unrecognized value).
export function getRegistrationMode(): 'admin_only' | 'open' {
	return env.REGISTRATION_MODE === 'open' ? 'open' : 'admin_only';
}

export async function isOnlyBackfillUser(): Promise<boolean> {
	const [totalUsers, backfillUser] = await Promise.all([
		prisma.user.count(),
		prisma.user.findUnique({
			where: { id: BACKFILL_USER_ID },
			select: {
				email: true
			}
		})
	]);

	return totalUsers === 1 && backfillUser?.email === BACKFILL_USER_EMAIL;
}

// Used by /login to know whether the link to /register should be shown: reflects
// self-service registration (initial bootstrap), not the "logged-in admin creates an account" case.
export async function isSelfRegistrationOpen(): Promise<boolean> {
	if (getRegistrationMode() === 'open') return true;
	if (await isOnlyBackfillUser()) return true;
	const userCount = await prisma.user.count();
	return userCount === 0;
}
