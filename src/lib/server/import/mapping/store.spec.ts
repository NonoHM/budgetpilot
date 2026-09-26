import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assertColumnMappingCapConfigured,
	COLUMN_MAPPINGS_PER_USER_CEILING,
	COLUMN_MAPPINGS_PER_USER_DEFAULT
} from './store';
import { ENVIRONMENT_CHECKS } from '../../env/assertConfigured';

// This module and the boot collector both reach the Prisma client. Nothing here queries a
// database, so the client is replaced rather than constructed: the test needs the collector's
// LIST, not a connection.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

// The variable's NAME is written out rather than read from the module's constant: it is the
// contract `.env.example` and `docs/configuration.md` document, so a rename must redden this file.
// The default and the ceiling are policy and are read from the module, because what is under test
// is the sentence built around them, not their values.
const NAME = 'COLUMN_MAPPINGS_PER_USER';

afterEach(() => {
	delete process.env[NAME];
});

/** Every warning the boot check prints for the configured value, in order. */
function bootWarnings(): string[] {
	const warnings: string[] = [];
	const spy = vi.spyOn(console, 'warn').mockImplementation((message: string) => {
		warnings.push(message);
	});
	try {
		assertColumnMappingCapConfigured();
	} finally {
		spy.mockRestore();
	}
	return warnings;
}

/** The boot check's refusal as the operator reads it, or a marker saying it did not refuse. */
function bootRefusal(): string {
	// Muted, because an accepted value that differs from the default warns, and the warnings are
	// asserted by the tests above rather than here.
	const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		assertColumnMappingCapConfigured();
	} catch (caught) {
		return caught instanceof Error ? caught.message : `not an Error: ${String(caught)}`;
	} finally {
		spy.mockRestore();
	}
	return 'no refusal';
}

describe('COLUMN_MAPPINGS_PER_USER at boot', () => {
	// The whole sentences are compared, never a fragment: these are log lines an operator reads,
	// and a fragment passes straight over a doubled or truncated tail.
	const differs = (cap: number) =>
		`[budgetpilot] ${NAME}=${cap} differs from the default of ${COLUMN_MAPPINGS_PER_USER_DEFAULT}. It bounds how many remembered column mappings one user may hold.`;

	it('says nothing at the default, unset or blank', () => {
		// The absence half. Its presence half is every test below: a check that never warned at all
		// would pass this one perfectly.
		const unset = bootWarnings();
		process.env[NAME] = '   ';
		const blank = bootWarnings();
		process.env[NAME] = String(COLUMN_MAPPINGS_PER_USER_DEFAULT);
		const explicit = bootWarnings();

		expect({ unset, blank, explicit }).toStrictEqual({ unset: [], blank: [], explicit: [] });
	});

	it('reports a lowered cap once, and does not call it raised', () => {
		// One below the default is the value where « differs » and « raised » disagree: a raised
		// warning keyed on `>=` or `!==` would fire here.
		const cap = COLUMN_MAPPINGS_PER_USER_DEFAULT - 1;
		process.env[NAME] = String(cap);

		expect(bootWarnings()).toStrictEqual([differs(cap)]);
	});

	it('reports a raised cap, and says what raising it lets one user hold', () => {
		// #737: this warning used to say that nothing deletes a column mapping (#326). #326 shipped
		// `deleteColumnMapping` and the Settings « Colonnes mémorisées » list, so an operator was told
		// something the application had stopped being true about. What stays true: no code path
		// removes one on its own (the three that delete are the Settings action, a backup restore
		// replacing the user's own, and the user's account going), so the cap is what bounds the
		// table between a user's visits to Settings.
		const cap = COLUMN_MAPPINGS_PER_USER_DEFAULT + 1;
		process.env[NAME] = String(cap);

		expect(bootWarnings()).toStrictEqual([
			differs(cap),
			`[budgetpilot] ${NAME} is RAISED above the default, so one user may now hold ${cap} column mappings. Nothing removes one automatically: the user deletes them in Settings.`
		]);
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
