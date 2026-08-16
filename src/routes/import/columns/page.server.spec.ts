import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The designation action's memorisation branch, which had NO server test of its own.
 *
 * `/import/columns/+page.server.ts` is where a user's four indices become a stored
 * correspondance, and until this file existed nothing asserted when that write happens. The
 * branch under test is the one a headerless file must not take: **a file whose first line is data
 * is designated every time and never memorised**, because the fingerprint is taken over the cells
 * of row 0 and for such a file row 0 changes with every statement.
 *
 * Measured rather than reasoned: the same headerless statement in June and in July produces
 * different digests, while a file whose header row is merely UNREADABLE produces identical ones.
 * A correspondance written here could never be found again — it would sit in a capped table
 * forever, counting against a limit whose only escape is deleting it by hand.
 *
 * Mocked at the store boundary, the same reasoning `/settings`' spec records: `store.db-smoke.ts`
 * already covers `saveColumnMapping`'s own guarantees against three real engines. What only this
 * level can show is WHETHER THE ROUTE CALLS IT.
 */

const store = vi.hoisted(() => ({
	saveColumnMapping: vi.fn(async () => ({ ok: true as const, id: 'mapping-1' })),
	recordColumnMappingUse: vi.fn(async () => {})
}));

const persist = vi.hoisted(() => ({
	createImportBatch: vi.fn(async () => 'batch-1'),
	persistImportedTransactions: vi.fn(async () => ({
		imported: 4,
		duplicates: 0,
		netWorthLinkStatus: null
	})),
	resolveImportBucketAccount: vi.fn(async () => ({ accountId: 'account-1', created: false }))
}));

const collision = vi.hoisted(() => ({
	describeIncomingBatch: vi.fn(() => ({ rowCount: 4, from: null, to: null, amountCents: 0 })),
	findCollidingBatch: vi.fn(async () => null)
}));

const db = vi.hoisted(() => ({
	prisma: { categorizationRule: { findMany: vi.fn(async () => []) } }
}));

vi.mock('$lib/server/import/mapping/store', () => store);
vi.mock('$lib/server/import/persist', () => persist);
vi.mock('$lib/server/import/collision', () => collision);
vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions } = await import('./+page.server');

/** Four transactions, three columns, and NO title row. */
const HEADERLESS = [
	'2026-06-01,Mercerie Lafayette,-45.20',
	'2026-06-02,Pharmacie du Pont,-18.90',
	'2026-06-03,Salaire,2450.00',
	'2026-06-07,Fleuriste Bellevue,-31.00'
].join('\n');

const WITH_HEADER = `date,label,amount\n${HEADERLESS}`;

async function submit(csv: string, hasHeaderRow: boolean) {
	const form = new FormData();
	form.set('csvFile', new File([csv], 'releve.csv', { type: 'text/csv' }));
	form.set('remember', 'true');
	form.set('hasHeaderRow', String(hasHeaderRow));
	form.set('dateIndex', '0');
	form.set('labelIndex', '1');
	form.set('amountIndex', '2');

	return actions.default({
		request: new Request('http://localhost/import/columns', { method: 'POST', body: form }),
		locals: { user: { id: 'user-a', email: 'a@example.test', role: 'USER' } }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

describe('the designation action and a file with no header row', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		persist.persistImportedTransactions.mockResolvedValue({
			imported: 4,
			duplicates: 0,
			netWorthLinkStatus: null
		});
		persist.resolveImportBucketAccount.mockResolvedValue({
			accountId: 'account-1',
			created: false
		});
		persist.createImportBatch.mockResolvedValue('batch-1');
	});

	it('writes NO correspondance, even though the user asked to remember', async () => {
		expect.assertions(2);

		await submit(HEADERLESS, false);

		// `remember` was posted as `true`. The refusal to memorise is the route's decision about
		// the FILE, not the user's about the convenience.
		expect(store.saveColumnMapping).not.toHaveBeenCalled();
		expect(store.recordColumnMappingUse).not.toHaveBeenCalled();
	});

	it('still imports every row, the first one included', async () => {
		expect.assertions(2);

		await submit(HEADERLESS, false);

		expect(persist.persistImportedTransactions).toHaveBeenCalledTimes(1);
		// FOUR. The defect this closes imported three and said nothing about the fourth. The
		// transactions are found by SHAPE rather than by argument position, so the assertion
		// survives a signature change instead of silently reading `undefined`.
		const [input] = persist.persistImportedTransactions.mock.calls[0] as unknown as [
			{ transactions: Array<{ label: string }> }
		];
		expect(input.transactions.map((t) => t.label)).toEqual([
			'Mercerie Lafayette',
			'Pharmacie du Pont',
			'Salaire',
			'Fleuriste Bellevue'
		]);
	});

	/**
	 * The direction this change is NOT moving in.
	 *
	 * An ordinary file must go on being memorised, or the whole column-mapping path stops working
	 * and every statement asks again. Same submission, same indices, one flag different.
	 */
	it('still memorises a file that HAS a header row', async () => {
		expect.assertions(2);

		await submit(WITH_HEADER, true);

		expect(store.saveColumnMapping).toHaveBeenCalledTimes(1);
		expect(store.recordColumnMappingUse).toHaveBeenCalledTimes(1);
	});
});
