import { getLocale } from '$lib/paraglide/runtime';

/**
 * The timestamp an import is identified BY, rendered to the second, in the reader's locale and
 * time zone. `CONTEXT.md`, « Import »: the timestamp is the only attribute that tells two imports of
 * one statement apart (#380).
 *
 * ONE function for every surface that names an import for the user to find it in `/imports`: the
 * history's own rows and its delete confirmation, and the banner that tells a user which partial
 * import to delete (D3). A second formatter is how two names for one import start disagreeing, and
 * `write-failure-banner.svelte.spec.ts` renders the banner and the history row from one `createdAt`
 * and requires the same string.
 *
 * MEASURED, and it is why this is not `timeStyle: 'short'` like several other surfaces. Running the
 * correction journey end to end produced two rows both reading « 17 août 2026 à 14:10 »: a repair
 * happens minutes after the import that went wrong, so the two land in the same minute often enough
 * that it cannot be called an edge. A discriminant that is not unique identifies nothing.
 *
 * This deviates from the plate, which writes the delete title as « Supprimer l'import du 1 juillet
 * 2026 à 10:59 ? ». The deviation is forced by the plate's own rule that the discriminant be unique,
 * so the rule is kept and the example is not.
 *
 * Runs where it is rendered: in the browser the reader's time zone applies, which is why the
 * server sends the ISO instant and never a formatted string.
 */
export function importTimestamp(iso: string): string {
	return new Date(iso).toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'medium' });
}
