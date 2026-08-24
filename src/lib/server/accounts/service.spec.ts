import { describe, expect, it } from 'vitest';
import { prefillAccountName } from './service';

/**
 * The name the create sheet opens with.
 *
 * Pure, and that is a constraint rather than a convenience: the value becomes `Account.name`, a
 * database column, so nothing about it may depend on an ambient locale, a clock or a random source.
 * `domain/money.ts` is the recorded instance of a module reaching for an ambient locale in this
 * repository: it passed `check`, four thousand unit tests, `lint:tracked` and a full Playwright
 * run, and died at container startup.
 *
 * Every test below names the TWO STATES it separates. A break-check proves a test can redden; it
 * does not prove it reddens for the reason it names.
 */
describe('the name the create sheet is prefilled with', () => {
	it('joins the bank we can name to the fragment the file carried', () => {
		// SEPARATES: « both facts the file offered are in the name » FROM « one of them is ». The
		// plate's own example is « Banque Populaire ···4417 », and it is the shape that tells two
		// accounts at one bank apart at the moment the second is created.
		expect(prefillAccountName({ institution: 'Banque Populaire', fragment: '4417' })).toBe(
			'Banque Populaire ···4417'
		);
	});

	it('prefills nothing when the file said nothing', () => {
		// SEPARATES: « the field opens empty » FROM « the field opens with a name manufactured from
		// something that is not about the user's bank ».
		//
		// DEVIATION FROM 6g, recorded rather than silent. The plate's caption reads « le nom est
		// pré-rempli depuis le fichier, jamais vide », and « jamais vide » occurs exactly once in the
		// whole plate. When the file carries neither an institution nor a fragment there is nothing
		// to prefill FROM, and both alternatives fabricate: a machine-shaped filename stem, or a
		// label naming our own parser. Everywhere else in 6g the prefill comes from something the
		// file SAID. Act on evidence that is present, never manufacture an answer from evidence that
		// is absent. Spec Part G carries the ruling.
		expect(prefillAccountName({ institution: null, fragment: null })).toBe('');
	});

	it('carries whichever half the file offered, alone', () => {
		// SEPARATES: « each half stands on its own » FROM « the name is built only when both are
		// present ». Both halves are reachable: an unrecognised bank with an IBAN column gives the
		// fragment alone, and a recognised bank whose export carries no identifier gives the
		// institution alone.
		expect(prefillAccountName({ institution: 'Revolut', fragment: null })).toBe('Revolut');
		expect(prefillAccountName({ institution: null, fragment: '9032' })).toBe('···9032');
	});

	it('never leaks more of the identifier than the fragment it was given', () => {
		// SEPARATES: « the name carries four characters » FROM « the name carries the identifier ».
		// The fragment is a sensitive class of its own (ASVS 5.0.0 14.1.1, as of the 2026-08-13
		// assessment of commit d9c116c) and this function is a place a whole IBAN could reach a
		// stored, displayed and exported column. It is not the caller's job to have cut it.
		const name = prefillAccountName({
			institution: 'Banque Populaire',
			fragment: 'FR7630001007941234567890185'
		});
		expect(name).toBe('Banque Populaire ···0185');
		expect(name).not.toContain('FR76');
	});
});
