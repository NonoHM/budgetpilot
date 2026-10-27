import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRIBUTE } from './names';

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

const data = await import('./data');
const { logUserPseudonym } = await import('./pseudonym');
const { REGISTRY } = await import('./events');

/**
 * The data events (L4b-2, #250): what each helper writes, under the wire names the contract fixes
 * (the owner rulings are recorded on #250 and in the PR that closes it). Literals on purpose, as in
 * `authz.spec.ts`: a constant renamed in names.ts must turn these red rather than follow along.
 *
 * THE RULE THESE PIN (owner, 2026-10-27): a line says WHAT WENT as a closed scope, and the
 * transaction bucket only qualifies it, so `0` beside `account` still reads as everything gone.
 */

const ACTOR = 'cl4b2actorrawid00000000001';
const TARGET = 'cl4b2targetrawid0000000002';

type Line = { event: string; attributes: Record<string, unknown> };
const lines = () => logged as Line[];
const attribute = (name: string) => lines().map((line) => line.attributes[name]);

beforeEach(() => {
	logged.length = 0;
});

describe('logSensitiveDelete (L4b-2)', () => {
	// Separates « the helper writes the contract's line » from « writes nothing », and from a line
	// carrying the raw count rather than its bucket.
	it('import_cancel: the import scope and the bucketed count', () => {
		data.logSensitiveDelete(ACTOR, 37, 'import_cancel');
		expect(logged).toEqual([
			{
				event: 'sensitive_delete',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.data.operation': 'import_cancel',
					'budgetpilot.data.scope': 'import',
					'budgetpilot.data.transactions_deleted': '10-99'
				}
			}
		]);
	});

	it('delete_user: the account scope and the target pseudonym, under the user key', () => {
		data.logSensitiveDelete(ACTOR, 1, 'delete_user', TARGET);
		expect(logged).toEqual([
			{
				event: 'sensitive_delete',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.data.operation': 'delete_user',
					'budgetpilot.data.scope': 'account',
					'budgetpilot.data.transactions_deleted': '1',
					'budgetpilot.target.user_pseudonym': logUserPseudonym(TARGET)
				}
			}
		]);
	});

	// The owner's case: an empty file restored over a full account must read as the wipe it is.
	// Separates « deleted and restored both said » from a line carrying only one of the two.
	it('restore: every record replaced, with what went and what came in', () => {
		data.logSensitiveDelete(ACTOR, 1500, 'restore', 0);
		expect(logged).toEqual([
			{
				event: 'sensitive_delete',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.data.operation': 'restore',
					'budgetpilot.data.scope': 'account_records',
					'budgetpilot.data.transactions_deleted': '1000+',
					'budgetpilot.data.transactions_restored': '0'
				}
			}
		]);
	});

	// The scope is the operation's, never the caller's, and a count of 0 does not move it: a
	// helper deriving the scope from the count (« nothing deleted ») fails every row.
	it('each operation carries its own scope, whatever the count, and only delete_user a target', () => {
		data.logSensitiveDelete(ACTOR, 0, 'delete_account');
		data.logSensitiveDelete(ACTOR, 0, 'delete_user', TARGET);
		data.logSensitiveDelete(ACTOR, 0, 'restore', 0);
		data.logSensitiveDelete(ACTOR, 0, 'import_cancel');
		data.logSensitiveDelete(ACTOR, 0, 'import_replace');
		expect(
			lines().map((line) => [
				line.attributes['budgetpilot.data.operation'],
				line.attributes['budgetpilot.data.scope'],
				line.attributes['budgetpilot.data.transactions_deleted'],
				Object.hasOwn(line.attributes, ATTRIBUTE.targetUserPseudonym),
				Object.hasOwn(line.attributes, 'budgetpilot.data.transactions_restored')
			])
		).toEqual([
			['delete_account', 'account', '0', false, false],
			['delete_user', 'account', '0', true, false],
			['restore', 'account_records', '0', false, true],
			['import_cancel', 'import', '0', false, false],
			['import_replace', 'import', '0', false, false]
		]);
	});

	// The bucket boundaries, each on the single value where a neighbouring bucket would also be
	// plausible: an off-by-one at any edge moves exactly one row of this table.
	it('buckets the count on every edge', () => {
		const counts = [0, 1, 2, 9, 10, 99, 100, 999, 1000, 250_000];
		for (const count of counts) data.logSensitiveDelete(ACTOR, count, 'import_cancel');
		expect(attribute('budgetpilot.data.transactions_deleted')).toEqual([
			'0',
			'1',
			'2-9',
			'2-9',
			'10-99',
			'10-99',
			'100-999',
			'100-999',
			'1000+',
			'1000+'
		]);
	});

	// A count is the engine's answer, so anything else is a defect upstream: refused loudly rather
	// than written as a plausible bucket. Separates « refuses » from « writes '0' » or « writes
	// '1000+' » for a value that is not a count.
	it('refuses a count that is not a non-negative integer, and writes nothing', () => {
		for (const bad of [-1, 1.5, Number.NaN]) {
			expect(() => data.logSensitiveDelete(ACTOR, bad, 'import_cancel')).toThrow(RangeError);
		}
		expect(logged).toEqual([]);
	});
});

describe('logSensitiveDelete, table A rev 3 (L4b-2)', () => {
	// Every operation the contract adds, with the fields each line carries beyond the user and the
	// operation. Separates « each operation names its own scope » from a shared or a caller-given
	// one, and « only the two prunes count records, only delete_transaction counts transactions »
	// from a line carrying a count field it has no answer for. Rev 3b: one records field for both
	// prunes, the scope saying which records.
	it('each operation carries its own scope and only its own count field', () => {
		data.logSensitiveDelete(ACTOR, 1, 'delete_transaction');
		data.logSensitiveDelete(ACTOR, 12, 'prune_tags');
		data.logSensitiveDelete(ACTOR, 'delete_category');
		data.logSensitiveDelete(ACTOR, 'delete_rule');
		data.logSensitiveDelete(ACTOR, 'delete_tag');
		data.logSensitiveDelete(ACTOR, 'delete_budget');
		data.logSensitiveDelete(ACTOR, 'delete_column_mapping');
		data.logSensitiveDelete(ACTOR, 'forget_remembered_account');
		data.logSensitiveDelete(ACTOR, 'delete_nature_mapping');
		data.logSensitiveDelete(ACTOR, 'delete_bank_connection');
		data.logSensitiveDelete(ACTOR, 'undo_bill_action');
		data.logSensitiveDelete(ACTOR, 'merge_budget');
		data.logSensitiveDelete(ACTOR, 'overrule_remembered_account');
		data.logSensitiveDelete(ACTOR, 4, 'prune_bill_actions');
		expect(
			lines().map((line) => {
				const {
					'budgetpilot.user.pseudonym': user,
					'budgetpilot.data.operation': operation,
					...rest
				} = line.attributes;
				return [user === logUserPseudonym(ACTOR), operation, rest];
			})
		).toEqual([
			[
				true,
				'delete_transaction',
				{
					'budgetpilot.data.scope': 'transaction',
					'budgetpilot.data.transactions_deleted': '1'
				}
			],
			[
				true,
				'prune_tags',
				{ 'budgetpilot.data.scope': 'tag', 'budgetpilot.data.records_deleted': '10-99' }
			],
			[true, 'delete_category', { 'budgetpilot.data.scope': 'category' }],
			[true, 'delete_rule', { 'budgetpilot.data.scope': 'rule' }],
			[true, 'delete_tag', { 'budgetpilot.data.scope': 'tag' }],
			[true, 'delete_budget', { 'budgetpilot.data.scope': 'budget' }],
			[true, 'delete_column_mapping', { 'budgetpilot.data.scope': 'column_mapping' }],
			[true, 'forget_remembered_account', { 'budgetpilot.data.scope': 'remembered_account' }],
			[true, 'delete_nature_mapping', { 'budgetpilot.data.scope': 'nature_mapping' }],
			[true, 'delete_bank_connection', { 'budgetpilot.data.scope': 'bank_connection' }],
			[true, 'undo_bill_action', { 'budgetpilot.data.scope': 'bill_action' }],
			[true, 'merge_budget', { 'budgetpilot.data.scope': 'budget' }],
			[true, 'overrule_remembered_account', { 'budgetpilot.data.scope': 'remembered_account' }],
			[
				true,
				'prune_bill_actions',
				{ 'budgetpilot.data.scope': 'bill_action', 'budgetpilot.data.records_deleted': '2-9' }
			]
		]);
	});

	// Every count is checked, not only the first: a restored or a tag count that is not a count is
	// a defect upstream too. Separates « each count refused » from « only the leading one ».
	it('refuses a restored count or a records count that is not a non-negative integer', () => {
		expect(() => data.logSensitiveDelete(ACTOR, 3, 'restore', -1)).toThrow(RangeError);
		expect(() => data.logSensitiveDelete(ACTOR, 2.5, 'prune_tags')).toThrow(RangeError);
		expect(() => data.logSensitiveDelete(ACTOR, -2, 'prune_bill_actions')).toThrow(RangeError);
		expect(logged).toEqual([]);
	});
});

describe('logSensitiveRead (L4b-2)', () => {
	// The backup is every record whatever the count; the CSV is the selection on screen.
	it('writes one sensitive_read line per export kind, with its scope and the bucketed count', () => {
		data.logSensitiveRead(ACTOR, 'backup', 0);
		data.logSensitiveRead(ACTOR, 'transactions_csv', 120);
		expect(logged).toEqual([
			{
				event: 'sensitive_read',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.data.export': 'backup',
					'budgetpilot.data.scope': 'account_records',
					'budgetpilot.data.transactions_exported': '0'
				}
			},
			{
				event: 'sensitive_read',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.data.export': 'transactions_csv',
					'budgetpilot.data.scope': 'selection',
					'budgetpilot.data.transactions_exported': '100-999'
				}
			}
		]);
	});
});

describe('logRestoreRefused (L4b-2, owner ruling 2026-10-27)', () => {
	it('writes one input_validation_fail line with the closed reason', () => {
		data.logRestoreRefused(ACTOR, 'unknown_category');
		expect(logged).toEqual([
			{
				event: 'input_validation_fail',
				attributes: {
					'budgetpilot.user.pseudonym': logUserPseudonym(ACTOR),
					'budgetpilot.restore.reason': 'unknown_category'
				}
			}
		]);
	});
});

describe('the data events carry no raw id and no client (R1)', () => {
	// The first figure calibrates the sweep: four lines were written and read.
	it('neither raw id appears in any line, while the pseudonyms do', () => {
		data.logSensitiveDelete(ACTOR, 5, 'delete_user', TARGET);
		data.logSensitiveDelete(ACTOR, 5, 'restore', 5);
		data.logSensitiveRead(ACTOR, 'backup', 5);
		data.logRestoreRefused(ACTOR, 'invalid_json');
		const text = JSON.stringify(logged);
		expect({
			lines: logged.length,
			actorPseudonym: text.includes(logUserPseudonym(ACTOR)),
			targetPseudonym: text.includes(logUserPseudonym(TARGET)),
			rawActor: text.includes(ACTOR),
			rawTarget: text.includes(TARGET),
			client: lines().some((line) => Object.hasOwn(line.attributes, ATTRIBUTE.clientPseudonym))
		}).toEqual({
			lines: 4,
			actorPseudonym: true,
			targetPseudonym: true,
			rawActor: false,
			rawTarget: false,
			client: false
		});
	});
});

describe('the registry rows the contract fixes', () => {
	// Separates « the destruction and export records survive BP_SECURITY_LOG=off » (an audit record,
	// like authz_admin) from « the restore refusal is a control-bypass event the switch drops ».
	it('severity, flood and security per event', () => {
		const row = (name: 'sensitive_delete' | 'sensitive_read' | 'input_validation_fail') => {
			const spec = REGISTRY[name];
			return [spec.severity, spec.flood, spec.security, spec.floodBy ?? []];
		};
		expect([row('sensitive_delete'), row('sensitive_read'), row('input_validation_fail')]).toEqual([
			// Rev 3: one-row deletes repeat at will, so repeats are summarised, keyed by every field
			// that tells two kinds apart, so a burst of one cannot hide a line of another.
			[
				'WARN',
				true,
				false,
				[
					'budgetpilot.data.operation',
					'budgetpilot.data.scope',
					'budgetpilot.data.transactions_deleted',
					'budgetpilot.data.transactions_restored',
					'budgetpilot.data.records_deleted',
					'budgetpilot.user.pseudonym',
					'budgetpilot.target.user_pseudonym'
				]
			],
			// The bucket is in the key (contradiction pass F2): twenty empty exports must not summarise
			// away the full one that follows them in the same minute.
			[
				'WARN',
				true,
				false,
				[
					'budgetpilot.data.export',
					'budgetpilot.data.transactions_exported',
					'budgetpilot.user.pseudonym'
				]
			],
			['WARN', true, true, ['budgetpilot.restore.reason', 'budgetpilot.user.pseudonym']]
		]);
	});
});
