import { describe, expect, it } from 'vitest';
import { readServerOrigin, SERVER_ORIGIN_META } from './originProbe';

function docWith(metaHtml: string): Document {
	return new DOMParser().parseFromString(
		`<html><head>${metaHtml}</head><body></body></html>`,
		'text/html'
	);
}

describe('readServerOrigin', () => {
	it('reads the origin the server put in the meta tag', () => {
		const doc = docWith(`<meta name="${SERVER_ORIGIN_META}" content="https://localhost:3999" />`);
		expect(readServerOrigin(doc)).toBe('https://localhost:3999');
	});

	// Each of these means "the answer did not arrive", which is NOT the same as "the origins
	// agree". A probe that confused the two would send every visitor to a diagnostic page the
	// first time the transform stopped running.
	it('returns null when the tag is absent', () => {
		expect(readServerOrigin(docWith(''))).toBeNull();
	});

	it('returns null when the value is empty', () => {
		expect(
			readServerOrigin(docWith(`<meta name="${SERVER_ORIGIN_META}" content="" />`))
		).toBeNull();
	});

	it('returns null when the placeholder was never replaced', () => {
		const doc = docWith(
			`<meta name="${SERVER_ORIGIN_META}" content="%budgetpilot.serverOrigin%" />`
		);
		expect(readServerOrigin(doc)).toBeNull();
	});

	it('ignores an unrelated meta tag', () => {
		expect(readServerOrigin(docWith('<meta name="text-scale" content="scale" />'))).toBeNull();
	});
});
