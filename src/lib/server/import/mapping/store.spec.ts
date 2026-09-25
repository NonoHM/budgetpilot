import { describe, expect, it, vi } from 'vitest';
import { assertColumnMappingCapConfigured } from './store';
import { ENVIRONMENT_CHECKS } from '../../env/assertConfigured';

// This module and the boot collector both reach the Prisma client. Nothing here queries a
// database, so the client is replaced rather than constructed: the test needs the collector's
// LIST, not a connection.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

describe('COLUMN_MAPPINGS_PER_USER at boot', () => {
	// WITHOUT THIS THE CEILING IS DECORATION: a cap nobody checks at boot refuses an operator's
	// out-of-range value on a user's first import instead, as a failure about a limit rather than
	// about their configuration. Compared by FUNCTION REFERENCE, which is what ENVIRONMENT_CHECKS is
	// exported for (#715). Before this file no spec named the cap's boot check at all, so nothing
	// could see its entry in `ENVIRONMENT_CHECKS` go; deleting that entry reddens this test,
	// registered 0 times (2026-09-25).
	it('is registered with the boot collector', () => {
		expect(
			ENVIRONMENT_CHECKS.filter(([, run]) => run === assertColumnMappingCapConfigured)
		).toHaveLength(1);
	});
});
