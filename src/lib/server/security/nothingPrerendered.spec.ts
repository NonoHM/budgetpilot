import { describe, expect, it } from 'vitest';
import { prerenderedRoutes } from '../../../../scripts/assert-nothing-prerendered.mjs';

// GHSA-27mw-82g8-phjj (kit < 3, #1148) needs a prerendered page. The CI step reads the built
// manifest through this parser; each case separates two states the step must tell apart.
describe('prerenderedRoutes', () => {
	it('reads an empty list as nothing prerendered', () => {
		expect(prerenderedRoutes('x,prerendered_routes: new Set([]),y')).toEqual([]);
	});

	it('names every prerendered route, so a planted one is reported rather than counted', () => {
		expect(prerenderedRoutes('prerendered_routes: new Set(["/about","/legal"]),')).toEqual([
			'/about',
			'/legal'
		]);
	});

	// A manifest the parser cannot find the list in is a broken read, never « nothing prerendered ».
	it('throws when the list is absent', () => {
		expect(() => prerenderedRoutes('export const manifest = {}')).toThrow(
			'found 0 prerendered_routes lists, expected exactly 1'
		);
	});

	it('throws when the list appears twice', () => {
		const one = 'prerendered_routes: new Set([])';
		expect(() => prerenderedRoutes(`${one};${one}`)).toThrow(
			'found 2 prerendered_routes lists, expected exactly 1'
		);
	});
});
