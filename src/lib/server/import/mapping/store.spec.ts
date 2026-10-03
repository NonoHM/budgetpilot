import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertColumnMappingCapConfigured,
	COLUMN_MAPPINGS_PER_USER_CEILING,
	COLUMN_MAPPINGS_PER_USER_DEFAULT
} from './store';
import { ENVIRONMENT_CHECKS } from '../../env/assertConfigured';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';

// This module and the boot collector both reach the Prisma client. Nothing here queries a
// database, so the client is replaced rather than constructed: the test needs the collector's
// LIST, not a connection.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

// The variable's NAME is written out rather than read from the module's constant: it is the
// contract `.env.example` and `docs/configuration.md` document, so a rename must redden this file.
// The default and the ceiling are policy and are read from the module, because what is under test
// is the event built around them, not their values.
const NAME = 'COLUMN_MAPPINGS_PER_USER';

afterEach(() => {
	delete process.env[NAME];
});

/** Every event the boot check logs for the configured value, in order. */
function bootEvents(): unknown[] {
	logged.length = 0;
	assertColumnMappingCapConfigured();
	return [...logged];
}

/** The boot check's refusal as the operator reads it, or a marker saying it did not refuse. */
function bootRefusal(): string {
	// An accepted value that differs from the default logs an event, which the mocked `log` records
	// and the tests above assert rather than here.
	try {
		assertColumnMappingCapConfigured();
	} catch (caught) {
		return caught instanceof Error ? caught.message : `not an Error: ${String(caught)}`;
	}
	return 'no refusal';
}

describe('COLUMN_MAPPINGS_PER_USER at boot', () => {
	// The whole events are compared, never a fragment: these are log lines an operator reads, and a
	// fragment passes straight over a wrong or extra attribute.
	const changed = (cap: number, direction: 'raised' | 'lowered') => ({
		event: EVENT.configBoundChanged,
		attributes: {
			[ATTRIBUTE.configName]: NAME,
			[ATTRIBUTE.configValue]: cap,
			[ATTRIBUTE.configDefault]: COLUMN_MAPPINGS_PER_USER_DEFAULT,
			[ATTRIBUTE.configDirection]: direction,
			// No honest minimum for this bound: a lowered cap refuses nothing that already works.
			[ATTRIBUTE.configBelowHonestMinimum]: false
		}
	});

	it('says nothing at the default, unset or blank', () => {
		// The absence half. Its presence half is every test below: a check that never warned at all
		// would pass this one perfectly.
		const unset = bootEvents();
		process.env[NAME] = '   ';
		const blank = bootEvents();
		process.env[NAME] = String(COLUMN_MAPPINGS_PER_USER_DEFAULT);
		const explicit = bootEvents();

		expect({ unset, blank, explicit }).toStrictEqual({ unset: [], blank: [], explicit: [] });
	});

	it('reports a lowered cap once, and does not call it raised', () => {
		// One below the default is the value where « differs » and « raised » disagree: a raised
		// warning keyed on `>=` or `!==` would fire here.
		const cap = COLUMN_MAPPINGS_PER_USER_DEFAULT - 1;
		process.env[NAME] = String(cap);

		expect(bootEvents()).toStrictEqual([changed(cap, 'lowered')]);
	});

	it('reports a raised cap, with the number one user may now hold', () => {
		// No code path removes a column mapping on its own (the three that delete are the Settings
		// action, a backup restore replacing the user's own, and the user's account going), so the
		// cap is what bounds the table between a user's visits to Settings, and the value is the
		// figure an operator compares against docs/configuration.md.
		const cap = COLUMN_MAPPINGS_PER_USER_DEFAULT + 1;
		process.env[NAME] = String(cap);

		expect(bootEvents()).toStrictEqual([changed(cap, 'raised')]);
	});

	it('refuses a value above the ceiling, rather than clamping it, and says why', () => {
		// Clamping is the tempting alternative and it is the one that lies: the operator reads their
		// own number in the environment while a different one is in force. #737: this refusal carried
		// the same false « nothing deletes a column mapping yet » as the raised warning.
		const cap = COLUMN_MAPPINGS_PER_USER_CEILING + 1;
		process.env[NAME] = String(cap);

		expect(bootRefusal()).toBe(
			`${NAME}=${cap} is above the hard ceiling of ${COLUMN_MAPPINGS_PER_USER_CEILING}. It bounds how many column mappings one user may hold, and nothing removes one automatically. The value is refused rather than clamped so that a bound you set is the bound that runs.`
		);
	});

	it('accepts the ceiling itself, so the boundary is not off by one', () => {
		// The single value where `>` and `>=` disagree.
		process.env[NAME] = String(COLUMN_MAPPINGS_PER_USER_CEILING);

		expect(bootRefusal()).toBe('no refusal');
	});

	it('refuses a value that is not a whole number of at least 1, naming what it got', () => {
		// Keyed per input rather than asserted in a loop, so a red names WHICH value went through.
		// '0' and '1' are the pair where `< 1` and `< 0` disagree; '1' is accepted and is in the
		// expectation below as `no refusal` so that pair is visible.
		const refusal = (raw: string) =>
			`${NAME} must be a whole number of at least 1, written in the digits 0 to 9 only (got ${JSON.stringify(raw)}). It bounds how many remembered column mappings one user may hold. The default is ${COLUMN_MAPPINGS_PER_USER_DEFAULT}.`;
		const inputs = ['0', '-1', '1.5', 'many', '1'];

		const got = Object.fromEntries(
			inputs.map((raw) => {
				process.env[NAME] = raw;
				return [raw, bootRefusal()];
			})
		);

		expect(got).toStrictEqual({
			'0': refusal('0'),
			'-1': refusal('-1'),
			'1.5': refusal('1.5'),
			many: refusal('many'),
			'1': 'no refusal'
		});
	});

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
