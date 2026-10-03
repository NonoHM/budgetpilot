/**
 * The form field names a re-authentication reads, defined once for both sides of the wire.
 *
 * `server/auth/reauth.ts` reads them off the posted form and `components/ui/ReauthFields.svelte`
 * renders inputs carrying them. A name retyped on one side and not the other is a form whose
 * password never arrives, which the server answers as « missing password » forever: the defect
 * would look exactly like a user who left the field empty.
 */
export const REAUTH_FIELDS = {
	password: 'currentPassword',
	code: 'code'
} as const;
