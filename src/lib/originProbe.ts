/**
 * The origin diagnostic's two shared pieces, in a plain module so both the probe and the page it
 * sends people to read the same ones, and so the reading logic has a spec that does not need a
 * component harness.
 *
 * DIAGNOSTIC, NOT A SECURITY CONTROL — see routes/setup/origin-mismatch/+page.server.ts for what
 * that means and why the CSRF check itself was deliberately left alone.
 */

export const ORIGIN_MISMATCH_ROUTE = '/setup/origin-mismatch';

export const SERVER_ORIGIN_META = 'budgetpilot:server-origin';

/**
 * The origin the server computed for this request, from the meta tag app.html carries.
 *
 * Returns null for every way the transport can fail: no tag, an empty value, or the placeholder
 * still sitting there unreplaced. All three mean "the answer did not arrive", which is NOT the
 * same as "the origins agree" — a probe that confused the two would send every visitor to a
 * diagnostic page the first time the transform stopped running.
 */
export function readServerOrigin(doc: Document): string | null {
	const content = doc
		.querySelector(`meta[name="${SERVER_ORIGIN_META}"]`)
		?.getAttribute('content')
		?.trim();
	if (!content) return null;
	if (content.startsWith('%') && content.endsWith('%')) return null;
	return content;
}
