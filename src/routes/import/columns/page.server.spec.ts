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
	// The read-only bucket lookup the route runs BEFORE the collision check, so the fingerprints
	// compared there are built against the account the run will land on. Null here, which is the
	// first-import case: the bucket does not exist yet, so it holds no keys to recognise.
	findImportBucketAccount: vi.fn(async () => null),
	// The shape `persistImportedTransactions` actually returns. It used to be
	// `{ imported, duplicates, netWorthLinkStatus }` here, which is a shape the route has not read
	// for some time: every figure it takes off this value was `undefined` and no test noticed,
	// because none of them asserted a figure. The replace guard reads `importedRows`, so the drift
	// had to be closed before it could be tested at all.
	persistImportedTransactions: vi.fn(async () => ({
		importedRows: 4,
		duplicateRows: 0,
		importedDebitCents: 0,
		importedCreditCents: 0
	})),
	resolveImportBucketAccount: vi.fn(async () => ({ accountId: 'account-1', created: false }))
}));

const collision = vi.hoisted(() => ({
	describeIncomingBatch: vi.fn(() => ({ rowCount: 4, from: null, to: null, amountCents: 0 })),
	findCollidingBatch: vi.fn(async () => null)
}));

const db = vi.hoisted(() => ({
	prisma: {
		categorizationRule: { findMany: vi.fn(async () => []) },
		importBatch: {
			findFirst: vi.fn(
				async (): Promise<{
					id: string;
					createdAt: Date;
					periodStart: Date | null;
					periodEnd: Date | null;
				} | null> => ({
					id: 'batch-old',
					createdAt: new Date('2026-06-30T10:00:00.000Z'),
					// The SAME days the fixture parses to, so the ordinary tests exercise the delete path.
					// Left null, the overlap check answers "unknown, do not withhold" and every test here
					// would pass without the route ever consulting the period — which is a mock deciding
					// the outcome rather than the code.
					periodStart: new Date('2026-06-01T00:00:00.000Z'),
					periodEnd: new Date('2026-06-07T00:00:00.000Z')
				})
			)
		},
		transaction: { count: vi.fn(async () => 0) }
	}
}));

const deleteBatch = vi.hoisted(() => ({ deleteImportBatch: vi.fn(async () => true) }));

vi.mock('$lib/server/import/mapping/store', () => store);
vi.mock('$lib/server/import/persist', () => persist);
vi.mock('$lib/server/import/collision', () => collision);
vi.mock('$lib/server/import/deleteBatch', () => deleteBatch);
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

async function submit(csv: string, hasHeaderRow: boolean, extra: Record<string, string> = {}) {
	const form = new FormData();
	form.set('csvFile', new File([csv], 'releve.csv', { type: 'text/csv' }));
	form.set('remember', 'true');
	form.set('hasHeaderRow', String(hasHeaderRow));
	form.set('dateIndex', '0');
	form.set('labelIndex', '1');
	form.set('amountIndex', '2');
	for (const [key, value] of Object.entries(extra)) form.set(key, value);

	// Typed at the seam rather than cast per assertion: the action's declared return is a union of
	// every `fail()` shape and the success one, and narrowing it here keeps each test reading the
	// field it means.
	return (await actions.default({
		request: new Request('http://localhost/import/columns', { method: 'POST', body: form }),
		locals: { user: { id: 'user-a', email: 'a@example.test', role: 'USER' } }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any)) as unknown as {
		status?: number;
		replaced?: {
			kind: 'none' | 'deleted' | 'withheld' | 'withheldOtherPeriod';
			replacedAt?: string;
			replacedRows?: number;
			importedRows?: number;
			replacedPeriod?: { from: string | null; to: string | null };
		};
	};
}

describe('the designation action and a file with no header row', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 4,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
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

/**
 * The replace, which is the wave's whole point, and the one guard that stands between it and a
 * silent loss of transactions.
 */
describe('a corrected import replaces the batch it was launched from', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		// `importedRows` rather than the older `imported`, because the guard reads it. A mock whose
		// shape has drifted from the route reads as `undefined` and compares false against every
		// number, so the guard would be untestable and look correct.
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 4,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});
		persist.resolveImportBucketAccount.mockResolvedValue({
			accountId: 'account-1',
			created: false
		});
		persist.createImportBatch.mockResolvedValue('batch-new');
		db.prisma.importBatch.findFirst.mockResolvedValue({
			id: 'batch-old',
			createdAt: new Date('2026-06-30T10:00:00.000Z'),
			periodStart: new Date('2026-06-01T00:00:00.000Z'),
			periodEnd: new Date('2026-06-07T00:00:00.000Z')
		});
		// Zero by default, so the ordinary tests below exercise the DELETE path rather than the
		// withholding one. The withholding tests set their own figure.
		db.prisma.transaction.count.mockResolvedValue(0);
		deleteBatch.deleteImportBatch.mockResolvedValue(true);
	});

	it('deletes the named batch AFTER the rows are written', async () => {
		expect.assertions(1);

		const order: string[] = [];
		persist.persistImportedTransactions.mockImplementationOnce(async () => {
			order.push('write');
			return {
				importedRows: 4,
				duplicateRows: 0,
				importedDebitCents: 0,
				importedCreditCents: 0
			};
		});
		deleteBatch.deleteImportBatch.mockImplementationOnce(async () => {
			order.push('delete');
			return true;
		});

		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		// The ordering IS the control, so it is asserted rather than assumed from reading the code.
		expect(order).toEqual(['write', 'delete']);
	});

	it('deletes NOTHING when the import is refused', async () => {
		expect.assertions(2);

		// A file whose every row is invalid under the posted designation. The worst outcome this
		// design can produce is the old rows destroyed and no new ones written, and the route
		// returns before any write on this path.
		const result = await submit('date,label,amount\nnot-a-date,,x', true, {
			replaceBatchId: 'batch-old'
		});

		expect(result.status).toBe(400);
		expect(deleteBatch.deleteImportBatch).not.toHaveBeenCalled();
	});

	it('withholds the delete when the corrected run imports FEWER rows than the batch it replaces', async () => {
		expect.assertions(2);

		// The only case in this design where the repair destroys more than it repairs. The control
		// consented to REPLACE, not to replace with less, so consent is re-taken once the numbers
		// exist. Asserted on the delete not happening, never only on the returned figure: a version
		// that reports the loss and deletes anyway would pass a figure-only assertion.
		db.prisma.transaction.count.mockResolvedValue(30);
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 28,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});

		const result = await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(deleteBatch.deleteImportBatch).not.toHaveBeenCalled();
		expect(result.replaced).toEqual({
			kind: 'withheld',
			replacedAt: '2026-06-30T10:00:00.000Z',
			replacedRows: 30,
			importedRows: 28
		});
	});

	it('deletes when the corrected run imports the same number, which is the boundary', async () => {
		expect.assertions(2);

		// Tested ON the boundary: equal is the single value where "fewer" and "fewer or equal"
		// disagree, and it is the ordinary case of a correction that only moved a label column.
		db.prisma.transaction.count.mockResolvedValue(4);
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 4,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});

		const result = await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(deleteBatch.deleteImportBatch).toHaveBeenCalledWith('user-a', 'batch-old');
		expect(result.replaced).toEqual({ kind: 'deleted', replacedAt: '2026-06-30T10:00:00.000Z' });
	});

	it('withholds the delete when the file handed back covers another period', async () => {
		expect.assertions(2);

		// THE WRONG STATEMENT. `correctionMatchesFile` on `/import` compares the header SHAPE, and two
		// statements from one bank have identical headers by construction, so it passes on precisely
		// the file that must not be accepted. Walked in a browser before this guard existed: correcting
		// a July import with June's file deleted July and left two copies of June, with the summary
		// reporting the deletion as a success.
		//
		// The counts are left EQUAL, which is what makes this test about the period rather than about
		// the fewer-rows guard: 4 imported against 4 replaced, so that guard cannot fire and this one
		// is the only thing standing between the user and the loss.
		db.prisma.transaction.count.mockResolvedValue(4);
		db.prisma.importBatch.findFirst.mockResolvedValue({
			id: 'batch-old',
			createdAt: new Date('2026-06-30T10:00:00.000Z'),
			periodStart: new Date('2026-07-01T00:00:00.000Z'),
			periodEnd: new Date('2026-07-31T00:00:00.000Z')
		});

		const result = await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		// Asserted on the delete not happening, never only on the returned figure: a version that
		// reports the mismatch and deletes anyway would pass a figure-only assertion.
		expect(deleteBatch.deleteImportBatch).not.toHaveBeenCalled();
		expect(result.replaced).toEqual({
			kind: 'withheldOtherPeriod',
			replacedAt: '2026-06-30T10:00:00.000Z',
			replacedPeriod: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' }
		});
	});

	it('deletes when the periods merely touch, which is the boundary', async () => {
		expect.assertions(1);

		// The single day where `<=` and `<` disagree. The fixture parses to 1–7 June, so a batch ending
		// on 1 June shares exactly one day with it. `periodOverlap.spec.ts` tests the function on this
		// boundary; this asserts the ROUTE is asking it, and asking it the right way round.
		db.prisma.importBatch.findFirst.mockResolvedValue({
			id: 'batch-old',
			createdAt: new Date('2026-06-30T10:00:00.000Z'),
			periodStart: new Date('2026-05-01T00:00:00.000Z'),
			periodEnd: new Date('2026-06-01T00:00:00.000Z')
		});

		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(deleteBatch.deleteImportBatch).toHaveBeenCalledWith('user-a', 'batch-old');
	});

	it('deletes an undated batch rather than withholding on what it cannot know', async () => {
		expect.assertions(1);

		// The direction this guard must not take. A batch with no recorded period holds no dated
		// transaction, so the delete destroys nothing, and withholding there would cost the user the
		// thirteen-step tail to protect an empty batch. The collision check makes the same call on the
		// same input for the same reason: this mechanism only speaks when it is certain.
		db.prisma.importBatch.findFirst.mockResolvedValue({
			id: 'batch-old',
			createdAt: new Date('2026-06-30T10:00:00.000Z'),
			periodStart: null,
			periodEnd: null
		});

		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(deleteBatch.deleteImportBatch).toHaveBeenCalledWith('user-a', 'batch-old');
	});

	it('counts the replaced batch live rather than reading its importedRows column', async () => {
		expect.assertions(1);

		// A fact about the past against a verdict on the present. If the user has deleted rows by
		// hand since that import, `importedRows` overstates what the delete will destroy, and the
		// guard would pass while real rows died.
		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(db.prisma.transaction.count).toHaveBeenCalledWith({
			where: { userId: 'user-a', importBatchId: 'batch-old' }
		});
	});

	it('resolves the posted batch id against this user before it can decide a delete', async () => {
		expect.assertions(2);

		// The id crossed a navigation in the browser's memory, so it is an input. Another user's
		// batch resolves to null and nothing downstream runs.
		db.prisma.importBatch.findFirst.mockResolvedValue(null);

		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-of-user-b' });

		// The WHERE clause and nothing else, which is what this test is named for and the reason it was
		// written: the plan's own tenancy test cannot fail, because it mocks this call to return null
		// and the mock therefore decides the outcome. Dropping `userId` from the production query
		// leaves that one green and reddens this one.
		//
		// Narrowed from asserting the whole call, which also pinned `select`. That coupling made the
		// one test standing between this route and an IDOR redden whenever a field was added to the
		// selection — twice now — and a test that cries wolf on unrelated changes is a test somebody
		// eventually edits without reading. `select` is not a security property and has its own
		// coverage in the period tests above, which fail outright if the period stops being selected.
		expect(db.prisma.importBatch.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 'batch-of-user-b', userId: 'user-a' } })
		);
		expect(deleteBatch.deleteImportBatch).not.toHaveBeenCalled();
	});

	it('excludes the replaced batch from the collision search', async () => {
		expect.assertions(1);

		await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(collision.findCollidingBatch).toHaveBeenCalledWith('user-a', expect.anything(), {
			excludeBatchId: 'batch-old'
		});
	});

	it('does not exclude anything when the run is not a correction', async () => {
		expect.assertions(1);

		// The direction this change is not moving in. The guard fired on the observed defect from a
		// run that carried no correction at all, and it has to go on doing that.
		await submit(WITH_HEADER, true);

		expect(collision.findCollidingBatch).toHaveBeenCalledWith('user-a', expect.anything(), {});
	});
});
