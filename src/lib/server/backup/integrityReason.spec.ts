import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Each `BackupImportError` throw site logs the reason it names (L4b-2, #250), and that reason is the
 * suffix of the message key the same site shows, so the log and the screen cannot disagree about
 * why a file was refused. The type closes the set of reasons; only this reads which site carries
 * which, so a site handed another site's reason fails here and nowhere else.
 *
 * The first figure calibrates: every throw site was read in the `reason, key` shape, so a site
 * written in another shape fails the count rather than escaping the comparison.
 */
describe('restore integrity refusals', () => {
	it('each throw site logs the suffix of the message key it shows', () => {
		const source = readFileSync('src/lib/server/backup/import.ts', 'utf8');
		const sites = [
			...source.matchAll(/new BackupImportError\(\s*'(\w+)',\s*m\.settings_backup_error_(\w+)\(/g)
		];
		expect([
			source.match(/new BackupImportError\(/g)?.length,
			sites.length,
			sites.filter(([, reason, key]) => reason !== key).map(([, reason, key]) => `${reason} ${key}`)
		]).toEqual([20, 20, []]);
	});
});
