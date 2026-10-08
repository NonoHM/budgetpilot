import { redirect, type RequestHandler } from '@sveltejs/kit';
import { clearSessionCookie, revokeSession } from '$lib/server/auth';
import { logSignedOut } from '$lib/server/logging/authn';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	// By the session the hook resolved, so a logout that started before another tab's
	// re-authenticated change committed still ends the session once its token has been replaced
	// (#249). With no session resolved there is nothing to end: `handleAuth` only lets that request
	// through as a redirect to /login, which never reaches this handler.
	if (locals.user) {
		await revokeSession(locals.user.sessionId);
		logSignedOut(locals.user.id);
	}
	clearSessionCookie(cookies);
	throw redirect(303, '/login');
};
