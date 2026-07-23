import { redirect, type RequestHandler } from '@sveltejs/kit';
import { clearSessionCookie, revokeSessionToken, SESSION_COOKIE } from '$lib/server/auth';

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	await revokeSessionToken(token);
	clearSessionCookie(cookies);
	throw redirect(303, '/login');
};
