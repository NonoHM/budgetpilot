import * as m from '$lib/paraglide/messages';

/**
 * What an import's stored `profile` is CALLED on screen.
 *
 * ## The defect this closes
 *
 * `/imports` rendered the stored token verbatim, in a badge on the card and in a table cell, so an
 * import read through a memorised correspondance displayed the word « mapped » to the user. That is
 * an internal vocabulary reaching the interface: nothing in the product ever explains it, and the
 * user has no way to connect it to the « Colonnes reconnues » block on the very same card, which is
 * what it actually means.
 *
 * ## Rendering only, never storage
 *
 * The stored value is untouched. It is a key: the parsers dispatch on it, the fingerprint logic
 * reads it, and one of them is `mapped`, which is the profile that resolves its columns through a
 * stored record rather than a header table. Renaming the column would be a migration to fix a
 * caption, and a localised string does not live in a database column.
 *
 * ## `maison` and `maison-v2` deliberately collapse
 *
 * They are two generations of one export format, and the distinction is a fact about the parser
 * rather than about the file the user recognises. A user who sees « Format maison » on one import
 * and « Format maison v2 » on the next would reasonably think they had exported something
 * different.
 *
 * An unknown token falls back to the token itself rather than to a generic label: a value this
 * function has never heard of is a defect somewhere upstream, and showing it is how it gets found.
 * Silently printing « CSV » over it would hide exactly the case this function exists to reveal.
 */
export function importProfileLabel(profile: string): string {
	switch (profile) {
		case 'banque-populaire':
			return m.imports_profile_banque_populaire();
		case 'revolut':
			return m.imports_profile_revolut();
		case 'maison':
		case 'maison-v2':
			return m.imports_profile_maison();
		case 'mapped':
			// « Sur mesure » and not « Colonnes désignées », which is what this said first. The badge is
			// a pill beside the card's timestamp and eighteen uppercase characters wrapped that
			// timestamp onto two lines: measured in a browser, invisible to every test, and the card
			// heads itself with that timestamp precisely because it is what tells two imports apart.
			//
			// It also stopped repeating the « Colonnes reconnues » block twelve pixels below it. What
			// the badge names is the FORMAT the file was read as, and for this profile the format is
			// the one the user designated themselves.
			return m.imports_profile_mapped();
		case 'generic':
			return m.imports_profile_generic();
		default:
			return profile;
	}
}
