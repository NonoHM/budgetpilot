import { describe, expect, it } from 'vitest';
import { chromeFor } from './appChrome';

/**
 * The chrome rule, which has now been wrong in both directions on the same route.
 *
 * Full chrome put a fixed tab bar over the designation screen's import button; no chrome at all
 * left the desktop screen without the header and navigation the correction route kept. Each
 * assertion below names the failure it stands against, so a later edit that flips one back has to
 * argue with the reason rather than with a list.
 */
describe('chromeFor', () => {
	it('gives an ordinary page the full chrome', () => {
		expect.assertions(3);

		expect(chromeFor('/')).toBe('full');
		expect(chromeFor('/transactions')).toBe('full');
		// The CORRECTION route keeps the full chrome, and that is the state /import/columns was
		// made to agree with rather than the other way round.
		expect(chromeFor('/imports/abc123/columns')).toBe('full');
	});

	/**
	 * `/import/columns` is desktop-only, and both halves matter.
	 *
	 * `'full'` would return the fixed mobile tab bar that covered the import button; `'none'`
	 * would take the header and navigation off the desktop screen again.
	 */
	it('gives the designation screen the desktop chrome and not the mobile one', () => {
		expect.assertions(3);

		const chrome = chromeFor('/import/columns');

		expect(chrome).toBe('desktop');
		expect(chrome).not.toBe('full');
		expect(chrome).not.toBe('none');
	});

	it('leaves the forced password change with no chrome at all', () => {
		expect.assertions(1);

		// The one route where removing the way out is the point.
		expect(chromeFor('/force-password-change')).toBe('none');
	});

	/**
	 * The rule matches a path exactly, and that is deliberate.
	 *
	 * `/import` is the upload page and an ordinary one; a prefix match would strip its chrome
	 * because `/import/columns` starts with it.
	 */
	it('matches the whole path, so /import keeps its chrome', () => {
		expect.assertions(2);

		expect(chromeFor('/import')).toBe('full');
		expect(chromeFor('/imports')).toBe('full');
	});
});
