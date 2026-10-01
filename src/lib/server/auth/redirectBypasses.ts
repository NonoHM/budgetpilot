/**
 * Test data: the redirect targets an attacker would try, one entry per bypass class. Read by the
 * unit spec, the route specs and the e2e journey, so the three layers are asked about the SAME
 * values; never imported by application code, which would let a corpus entry decide the rule it is
 * meant to test.
 *
 * Plain TypeScript with no imports, so `e2e/` can load it without the `$lib` aliases.
 *
 * Control characters are built with `String.fromCharCode` rather than written as escapes, because
 * an escape typed through a tool that takes JSON lands in the file as the raw byte, and a NUL byte
 * makes a tracked file invisible to every text search (`searchable-source.spec.ts`).
 */
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const DEL = String.fromCharCode(0x7f);
const NBSP = String.fromCharCode(0xa0);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const FULLWIDTH_SOLIDUS = String.fromCharCode(0xff0f);

/** The host every bypass points at. A reserved name, so a leaked request resolves nowhere. */
export const BYPASS_HOST = 'evil.test';

export interface RedirectBypass {
	/** The test name: which class of bypass this entry stands for. */
	readonly name: string;
	readonly value: string;
}

/** Every entry must fall back to the safe default. */
export const REDIRECT_BYPASSES: readonly RedirectBypass[] = [
	{ name: 'an absolute https URL', value: `https://${BYPASS_HOST}/` },
	{ name: 'an absolute URL with an uppercase scheme', value: `HTTPS://${BYPASS_HOST}/` },
	{ name: 'a protocol-relative URL', value: `//${BYPASS_HOST}/` },
	{ name: 'three leading slashes', value: `///${BYPASS_HOST}/` },
	{ name: 'a slash then a backslash', value: `/\\${BYPASS_HOST}/` },
	{ name: 'two backslashes', value: `\\\\${BYPASS_HOST}/` },
	{ name: 'a backslash then a slash', value: `\\/${BYPASS_HOST}/` },
	{ name: 'a backslash later in the path', value: `/a\\..\\\\${BYPASS_HOST}/` },
	{ name: 'a dot segment before two slashes', value: `/.//${BYPASS_HOST}/` },
	{ name: 'a parent segment before two slashes', value: `/a/..//${BYPASS_HOST}/` },
	{ name: 'an encoded parent segment', value: `/%2e%2E//${BYPASS_HOST}/` },
	{ name: 'a half-encoded dot segment', value: `/.%2e//${BYPASS_HOST}/` },
	{ name: 'an encoded slash pair', value: `/%2F%2F${BYPASS_HOST}/` },
	{ name: 'an encoded slash in lowercase', value: `/%2f/${BYPASS_HOST}/` },
	{ name: 'an encoded backslash', value: `/%5C${BYPASS_HOST}/` },
	{ name: 'a fully encoded protocol-relative URL', value: `%2F%2F${BYPASS_HOST}/` },
	{ name: 'a scheme with no slashes', value: `https:${BYPASS_HOST}` },
	{ name: 'a javascript: scheme', value: 'javascript:alert(1)' },
	{ name: 'a data: scheme', value: 'data:text/html,x' },
	{ name: 'a leading space', value: ` //${BYPASS_HOST}/` },
	{ name: 'a leading tab', value: `${TAB}//${BYPASS_HOST}/` },
	{ name: 'a leading no-break space', value: `${NBSP}//${BYPASS_HOST}/` },
	{ name: 'a tab between the slashes', value: `/${TAB}/${BYPASS_HOST}/` },
	{ name: 'a line feed between the slashes', value: `/${LF}/${BYPASS_HOST}/` },
	{ name: 'a carriage return between the slashes', value: `/${CR}/${BYPASS_HOST}/` },
	{ name: 'a NUL between the slashes', value: `/${NUL}/${BYPASS_HOST}/` },
	{ name: 'a C0 control before the slashes', value: `${SOH}//${BYPASS_HOST}/` },
	{ name: 'a DEL in the path', value: `/${DEL}/${BYPASS_HOST}/` },
	{ name: 'a line separator in the path', value: `/${LINE_SEPARATOR}/${BYPASS_HOST}/` },
	{ name: 'a fullwidth solidus', value: `/${FULLWIDTH_SOLIDUS}${BYPASS_HOST}/` },
	{ name: 'a space inside the path', value: `/ /${BYPASS_HOST}/` },
	{ name: 'a lone percent sign', value: '/%' },
	{ name: 'a percent escape that is not hexadecimal', value: '/%zz' },
	{ name: 'a percent escape that is not UTF-8', value: '/%E9' },
	{ name: 'an empty value', value: '' },
	{ name: 'a relative path with no leading slash', value: `${BYPASS_HOST}/` }
];

/** Values a legitimate flow produces, each of which must survive unchanged. */
export const REDIRECT_KEPT: readonly RedirectBypass[] = [
	{ name: 'the root', value: '/' },
	{ name: 'a plain page', value: '/transactions' },
	{ name: 'a page with a query', value: '/transactions?period=2026-01&tag=abc' },
	{ name: 'an encoded slash inside the query', value: '/reports?from=2026%2F01' },
	{ name: 'an encoded character in the path', value: '/imports/c%C3%A9' },
	{ name: 'a fragment', value: '/settings#tags' },
	{ name: 'dot segments inside the query, which are data', value: '/reports?path=/../x' },
	{ name: 'a dot inside a segment', value: '/imports/v1.2/a..b' },
	{ name: 'a lone percent sign inside the query', value: '/transactions?q=100%' },
	{
		name: 'a pipe in the query, which the URL parser leaves unencoded',
		value: '/transactions?q=a|b'
	}
];
