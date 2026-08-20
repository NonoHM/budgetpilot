import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from './appVersion';

/**
 * The app displayed its own version nowhere — not in Settings, not in a footer, not in a header.
 * Which made "which version am I on" answerable only by reading the `.env` that pins the image,
 * and unanswerable for anyone who did not install it themselves.
 *
 * That absence is also what made the version-pinning problem in the install docs worse than it
 * looked: a user running a stale `latest` had no way to find out, from inside the product, that
 * they were.
 *
 * Asserted against `package.json` — the file release-please bumps — rather than against a
 * hardcoded number, so this stays true across every release instead of needing a bump of its own.
 */
describe('APP_VERSION', () => {
	it("is the package's own version, injected at build time", () => {
		expect.assertions(2);

		const pkg = JSON.parse(
			readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
		) as { version: string };

		// Calibration: a version that were empty or a leftover placeholder would satisfy a bare
		// equality against an equally broken read, so the shape is asserted independently.
		expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
		expect(APP_VERSION).toBe(pkg.version);
	});
});
