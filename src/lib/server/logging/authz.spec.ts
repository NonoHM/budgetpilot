import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE, EVENT } from './names';
import type { LogEvent } from './events';
import type { LogPseudonym, LogSubnetPseudonym, LogUserPseudonym } from './pseudonym';

vi.hoisted(() => {
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: unknown) => {
		logged.push(event);
	}
}));

// The log pseudonyms import the limiter, which imports the database; nothing here queries it.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const authz = await import('./authz');
const { logUserPseudonym } = await import('./pseudonym');
const { REGISTRY } = await import('./events');

/**
 * The authorization events (L4a contract): what each helper writes, under the wire names the
 * contract fixes. The wire names are written as literals on purpose: they are the contract, and a
 * constant renamed in names.ts must turn these red rather than follow along.
 *
 * The user and the target are `logUserPseudonym(id)`, the production function, never a retyped
 * HMAC. The raw ids are distinctive so the absence sweep below can only miss them by not reading.
 */

const ACTOR = 'cl4aactorrawid000000000001';
const TARGET = 'cl4atargetrawid00000000002';

const REFERENCES = [
	'transaction',
	'split_category',
	'rule',
	'category',
	'tag',
	'session',
	'column_mapping',
	'import_batch',
	'account',
	'net_worth_account',
	'budget',
	'savings_goal',
	'bill_action',
	'bank_connection',
	'bank_authorization',
	'remembered_account',
	'nature_mapping'
] as const;

type Line = { event: string; attributes: Record<string, unknown> };
const lines = () => logged as Line[];

beforeEach(() => {
	logged.length = 0;
});

describe('logReferenceRefused (L4a)', () => {
	// Separates « the helper writes the contract's line » from « writes nothing » (the seam today)
	// and from « writes the raw id, or the wrong name ».
	it('writes one authz_fail line naming the caller by pseudonym, the reason and the reference', () => {
		authz.logReferenceRefused(ACTOR, 'transaction');
		expect(logged).toEqual([
			{
				event: 'authz_fail',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.authz.reason': 'not_found_or_not_owned',
					'budgetpilot.authz.reference': 'transaction'
				}
			}
		]);
	});

	// One line per call, each carrying its own kind: a helper that hard-coded one kind, or wrote one
	// line per process, passes the test above and fails this one.
	it('writes each of the seventeen reference kinds as itself, one line per call', () => {
		for (const reference of REFERENCES) authz.logReferenceRefused(ACTOR, reference);
		expect(
			lines().map((line) => [line.event, line.attributes['budgetpilot.authz.reference']])
		).toEqual(REFERENCES.map((reference) => ['authz_fail', reference]));
	});
});

describe('logRoleRefused (L4a)', () => {
	// Separates « role_required with no reference » from a helper that reused the reference shape.
	it('writes one authz_fail line with role_required and no reference attribute', () => {
		authz.logRoleRefused(ACTOR);
		expect(logged).toEqual([
			{
				event: 'authz_fail',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.authz.reason': 'role_required'
				}
			}
		]);
	});
});

describe('logAdminAction (L4a)', () => {
	it('delete_user and reset_password carry the target pseudonym, under the user key', () => {
		authz.logAdminAction(ACTOR, 'delete_user', TARGET);
		authz.logAdminAction(ACTOR, 'reset_password', TARGET);
		expect(logged).toEqual(
			['delete_user', 'reset_password'].map((action) => ({
				event: 'authz_admin',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.admin.action': action,
					'budgetpilot.target.user_pseudonym': logUserPseudonym(TARGET)
				}
			}))
		);
	});

	it('create_account carries the new account as its target', () => {
		authz.logAdminAction(ACTOR, 'create_account', TARGET);
		expect(logged).toEqual([
			{
				event: 'authz_admin',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.admin.action': 'create_account',
					'budgetpilot.target.user_pseudonym': logUserPseudonym(TARGET)
				}
			}
		]);
	});

	// Separates « the invitation actions name no target » from a helper that always writes the key
	// (an undefined value would serialise away, so the KEY is what is asserted absent).
	it('create_invitation and revoke_invitation carry no target attribute', () => {
		authz.logAdminAction(ACTOR, 'create_invitation');
		authz.logAdminAction(ACTOR, 'revoke_invitation');
		expect(logged).toEqual(
			['create_invitation', 'revoke_invitation'].map((action) => ({
				event: 'authz_admin',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.admin.action': action
				}
			}))
		);
	});
});

describe('the authorization events carry no raw id, no client and no subnet (L4a, R1)', () => {
	function writeEveryShape(): void {
		authz.logReferenceRefused(ACTOR, 'budget');
		authz.logRoleRefused(ACTOR);
		authz.logAdminAction(ACTOR, 'delete_user', TARGET);
		authz.logAdminAction(ACTOR, 'create_invitation');
	}

	// The first figure calibrates the sweep: five lines were written and read. Separates « no raw id
	// in the lines » from « no lines at all », which is what the seam writes today.
	it('neither raw id appears in any line, while the pseudonyms do', () => {
		writeEveryShape();
		const text = JSON.stringify(logged);
		expect({
			lines: logged.length,
			actorPseudonym: text.includes(logUserPseudonym(ACTOR)),
			targetPseudonym: text.includes(logUserPseudonym(TARGET)),
			rawActor: text.includes(ACTOR),
			rawTarget: text.includes(TARGET)
		}).toEqual({
			lines: 4,
			actorPseudonym: true,
			targetPseudonym: true,
			rawActor: false,
			rawTarget: false
		});
	});

	// The first element of each row calibrates the reading: a key the line carries reads as present.
	it('no line carries a client pseudonym, a subnet label or a width', () => {
		writeEveryShape();
		expect(
			lines().map((line) => [
				Object.hasOwn(line.attributes, ATTRIBUTE.userPseudonym),
				Object.hasOwn(line.attributes, ATTRIBUTE.clientPseudonym),
				Object.hasOwn(line.attributes, ATTRIBUTE.clientSubnetPseudonym),
				Object.hasOwn(line.attributes, ATTRIBUTE.clientSubnetPrefixLength)
			])
		).toEqual([
			[true, false, false, false],
			[true, false, false, false],
			[true, false, false, false],
			[true, false, false, false]
		]);
	});
});

describe('the registry rows for the authorization events (L4a contract table)', () => {
	type Row = {
		severity: string;
		flood: boolean;
		floodBy?: readonly string[];
		security: boolean;
		attributes: Record<string, string>;
	};
	const row = (name: string) => (REGISTRY as unknown as Record<string, Row | undefined>)[name];
	const shape = (spec: Row | undefined) =>
		spec && {
			severity: spec.severity,
			flood: spec.flood,
			floodBy: spec.floodBy ? [...spec.floodBy].sort() : undefined,
			security: spec.security,
			attributes: spec.attributes
		};

	// Separates « dropped by BP_SECURITY_LOG=off and flood-summarised per reason, kind and user »
	// from any other choice. floodBy is compared as a set: its order carries no meaning.
	it('authz_fail is WARN, flood-summarised by reason, reference and user, and a security event', () => {
		expect(shape(row(EVENT.authzFail))).toEqual({
			severity: 'WARN',
			flood: true,
			floodBy: [
				'budgetpilot.authz.reason',
				'budgetpilot.authz.reference',
				'budgetpilot.user.pseudonym'
			].sort(),
			security: true,
			// The contract's Levels line: the closed sets Operational, the pseudonym Pseudonymous.
			attributes: {
				'budgetpilot.authz.reason': 'Operational',
				'budgetpilot.authz.reference': 'Operational',
				'budgetpilot.user.pseudonym': 'Pseudonymous'
			}
		});
	});

	// Separates « a privileged action's record no setting drops » (security false, like
	// budgetpilot.ai.inference_halted) from a security event BP_SECURITY_LOG=off would drop.
	it('authz_admin is WARN, never flood-summarised, and not a security event', () => {
		expect(shape(row(EVENT.authzAdmin))).toEqual({
			severity: 'WARN',
			flood: false,
			floodBy: undefined,
			security: false,
			attributes: {
				'budgetpilot.admin.action': 'Operational',
				'budgetpilot.target.user_pseudonym': 'Pseudonymous',
				'budgetpilot.user.pseudonym': 'Pseudonymous'
			}
		});
	});
});

/**
 * Contract invariant 6, by type: neither authorization event can carry the client pseudonym or a
 * subnet field, written as a literal or SPREAD from an object carrying them (L3 lesson 1: a spread
 * skips excess-property checks, so the event types must declare those keys `?: never`).
 *
 * HOW THESE CAN BE RED. A `@ts-expect-error` over an event that is not in the `LogEvent` union at
 * all is satisfied for the wrong reason (no member matches anything). So each event has a POSITIVE
 * control written without the directive: a well-formed line that must compile. Before the union has
 * the two members, the controls are svelte-check errors; once it has them, the controls compile and
 * the directives are satisfied only if the forbidden keys are refused. Run time builds the objects
 * and asserts their names, so vitest's assertion count holds.
 */
describe('the authorization events refuse client and subnet fields (L4a invariant 6, by type)', () => {
	const hash = '0'.repeat(64);
	const client = {
		[ATTRIBUTE.clientPseudonym]: hash as LogPseudonym,
		[ATTRIBUTE.clientSubnetPseudonym]: hash as LogSubnetPseudonym,
		[ATTRIBUTE.clientSubnetPrefixLength]: 32
	};

	it('authz_fail: compiles bare, refuses a client pseudonym or a subnet, literal or spread', () => {
		const control: LogEvent = {
			event: EVENT.authzFail,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.authzReason]: 'not_found_or_not_owned',
				[ATTRIBUTE.authzReference]: 'rule'
			}
		};
		// @ts-expect-error authz_fail carries no client pseudonym, written as a literal
		const clientLiteral: LogEvent = {
			event: EVENT.authzFail,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.authzReason]: 'role_required',
				[ATTRIBUTE.clientPseudonym]: hash as LogPseudonym
			}
		};
		// @ts-expect-error authz_fail carries no subnet label, written as a literal
		const subnetLiteral: LogEvent = {
			event: EVENT.authzFail,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.authzReason]: 'role_required',
				[ATTRIBUTE.clientSubnetPseudonym]: hash as LogSubnetPseudonym
			}
		};
		// @ts-expect-error nor spread from an object carrying the client and subnet fields
		const spread: LogEvent = {
			event: EVENT.authzFail,
			attributes: {
				...client,
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.authzReason]: 'not_found_or_not_owned',
				[ATTRIBUTE.authzReference]: 'tag'
			}
		};
		expect([control, clientLiteral, subnetLiteral, spread].map((line) => line.event)).toEqual(
			Array(4).fill(EVENT.authzFail)
		);
	});

	it('authz_admin: compiles bare, refuses a client pseudonym or a subnet, literal or spread', () => {
		const control: LogEvent = {
			event: EVENT.authzAdmin,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.adminAction]: 'delete_user',
				[ATTRIBUTE.targetUserPseudonym]: hash as LogUserPseudonym
			}
		};
		// @ts-expect-error authz_admin carries no client pseudonym, written as a literal
		const clientLiteral: LogEvent = {
			event: EVENT.authzAdmin,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.adminAction]: 'create_invitation',
				[ATTRIBUTE.clientPseudonym]: hash as LogPseudonym
			}
		};
		// @ts-expect-error authz_admin carries no subnet width, written as a literal
		const subnetLiteral: LogEvent = {
			event: EVENT.authzAdmin,
			attributes: {
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.adminAction]: 'create_invitation',
				[ATTRIBUTE.clientSubnetPrefixLength]: 32
			}
		};
		// @ts-expect-error nor spread from an object carrying the client and subnet fields
		const spread: LogEvent = {
			event: EVENT.authzAdmin,
			attributes: {
				...client,
				[ATTRIBUTE.userPseudonym]: hash as LogUserPseudonym,
				[ATTRIBUTE.adminAction]: 'revoke_invitation'
			}
		};
		expect([control, clientLiteral, subnetLiteral, spread].map((line) => line.event)).toEqual(
			Array(4).fill(EVENT.authzAdmin)
		);
	});

	// The helper's overloads: a target on an invitation action, or none on delete_user, is a compile
	// error. Never invoked: only the signature is under test. Red if the signature is widened to one
	// optional `targetUserId` (the seam already carries the overloads, so these hold today).
	it('logAdminAction refuses a target on create_invitation and requires one on delete_user', () => {
		const calls = [
			() => authz.logAdminAction('admin', 'delete_user', 'target'),
			() => authz.logAdminAction('admin', 'create_invitation'),
			// @ts-expect-error an invitation action names no target
			() => authz.logAdminAction('admin', 'create_invitation', 'target'),
			// @ts-expect-error delete_user requires its target
			() => authz.logAdminAction('admin', 'delete_user')
		];
		expect(calls.map((call) => typeof call)).toEqual(Array(4).fill('function'));
	});
});
