import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { refusalLabel } from '$lib/i18n/refusalLabel';

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
	/**
	 * The account the USER CHOSE, resolved once and used by both the collision check and the write.
	 *
	 * It replaced a name-based lookup that could return null for a bucket not yet created. There is
	 * no such case now: an account picked from the panel exists, so one shape serves both callers
	 * and they can no longer reason about two different accounts.
	 */
	resolveImportBucketAccountById: vi.fn(async () => ({
		accountId: 'account-1',
		currency: 'EUR',
		exponent: 2,
		providerAccountId: null,
		bankConnectionId: null
	})),
	// A REAL class, because the route branches on `instanceof` to tell the archived refusal from the
	// not-found one. A plain object here would make every refusal read as not-found and the archived
	// case would go untested while looking tested.
	ImportBucketAccountError: class ImportBucketAccountError extends Error {
		reason: 'not-found' | 'archived';
		constructor(reason: 'not-found' | 'archived') {
			super(reason);
			this.reason = reason;
		}
	},
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
	}))
}));

const collision = vi.hoisted(() => ({
	describeIncomingBatch: vi.fn(() => ({ rowCount: 4, from: null, to: null, amountCents: 0 })),
	findCollidingBatch: vi.fn(async () => null)
}));

const db = vi.hoisted(() => ({
	prisma: {
		// The limiter this door now consults. `count` returning 0 is the honest "not limited",
		// which is the state these tests assume; the thresholds are asserted in
		// `auth/rateLimit.spec.ts`.
		loginAttempt: {
			count: vi.fn(async () => 0),
			create: vi.fn(async () => ({})),
			deleteMany: vi.fn(async () => ({ count: 0 }))
		},
		categorizationRule: { findMany: vi.fn(async () => []) },
		/**
		 * The read behind the summary's « N lignes importées dans X ».
		 *
		 * Returns a REAL account shape rather than null, because null makes the line absent and an
		 * absent line is what every one of these tests would report if the read were broken. The
		 * name it returns is deliberately not the stored key: `displayAccountName` substitutes for
		 * the generic bucket, and a fixture named « Compte import CSV » here would make this fake
		 * decide which branch the projection takes.
		 */
		account: {
			findFirst: vi.fn(async () => ({
				name: 'Compte de test',
				nameKey: 'compte-de-test',
				source: 'csv',
				institution: null
			}))
		},
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
// `ImportWriteError` is the REAL class, for the reason `ImportBucketAccountError` above gives: the
// write step's classifier branches on `instanceof`, and a stand-in would make every failure read as
// an unrecognised one.
vi.mock('$lib/server/import/persist', async (importOriginal) => ({
	ImportWriteError: (await importOriginal<typeof import('$lib/server/import/persist')>())
		.ImportWriteError,
	...persist
}));
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
	// The account is now part of every designation, so the helper posts one. A submission without
	// it is a refusal, and that refusal has its own tests rather than being the default every other
	// test would silently exercise.
	form.set('accountId', 'account-1');
	for (const [key, value] of Object.entries(extra)) form.set(key, value);

	// Typed at the seam rather than cast per assertion: the action's declared return is a union of
	// every `fail()` shape and the success one, and narrowing it here keeps each test reading the
	// field it means.
	return (await actions.default({
		request: new Request('http://localhost/import/columns', { method: 'POST', body: form }),
		locals: { user: { id: 'user-a', email: 'a@example.test', role: 'USER' } },
		// This door is rate limited like the other two, so the action reads the caller's address.
		getClientAddress: () => '127.0.0.1'
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any)) as unknown as {
		status?: number;
		data?: { error?: string; keepDesignation?: boolean };
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
		persist.resolveImportBucketAccountById.mockResolvedValue({
			accountId: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
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
		persist.resolveImportBucketAccountById.mockResolvedValue({
			accountId: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
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

	/**
	 * D3 (#662): the write itself failed, after two rows landed. Before, the throw left this action
	 * uncaught, so the delete below it never ran either, but the user met a bare 500 and the error
	 * page replaced the screen holding their designations. Now it is a sentence, and the ordering
	 * guarantee still has to hold on this branch: a correction whose write failed must not delete the
	 * import it was meant to replace.
	 */
	it('deletes NOTHING and names the rows saved when the write fails midway', async () => {
		expect.assertions(4);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { ImportWriteError } = await import('$lib/server/import/persist');
		persist.persistImportedTransactions.mockRejectedValueOnce(
			new ImportWriteError({ kind: 'failed', landedRows: 2 })
		);

		const result = await submit(WITH_HEADER, true, { replaceBatchId: 'batch-old' });

		expect(deleteBatch.deleteImportBatch).not.toHaveBeenCalled();
		expect(result.status).toBe(500);
		expect(result.data?.error).toBe(
			"L'import s'est arrêté après 2 transactions enregistrées. Supprimez-le dans Imports, puis réessayez."
		);
		// The designations stay on screen: the repair is on `/imports`, not a new designation.
		expect(result.data?.keepDesignation).toBe(true);
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

describe('the account a statement is filed into, and the five ways the id can be wrong', () => {
	/**
	 * THE 5XX STANDARD, WHICH IS ALREADY SET AND MUST NOT REGRESS.
	 *
	 * The last audit drove 49 form actions through two hostile passes with ZERO server errors.
	 * `accountId` is the first client-supplied object reference this route has ever accepted, so it
	 * is the first new way to try to break that, and every one of the five wrong answers below has
	 * to come back as something the user can read and act on.
	 *
	 * The refusal says what to DO, not what went wrong. « Choisissez le compte de ce relevé avant
	 * d'importer » rather than « accountId invalide », which names a field the user never saw and
	 * leaves them nothing to do about it.
	 *
	 * WHAT THIS FILE CAN AND CANNOT PROVE. The resolver is mocked here, so the four not-found cases
	 * necessarily collapse into one behaviour: this asserts what the ROUTE does with a refusal.
	 * That the four are genuinely refused, and refused INDISTINGUISHABLY, is asserted against a real
	 * engine in `resolveByChosenId.db-smoke.ts`, because a fake decides what `findFirst` returns and
	 * « the query was scoped by userId » and « the fake had nothing to return » are the same green.
	 */
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 4,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});
		persist.createImportBatch.mockResolvedValue('batch-1');
	});

	const NOT_FOUND = ['not-a-cuid', '', 'clbogus000000000000000000', 'another-users-account-id'];

	it.each(NOT_FOUND)(
		'refuses accountId %j with a readable 400 and never a server error',
		async (accountId) => {
			// SEPARATES: « the route refused and said what to do » FROM « the route threw and the
			// user got a 500 ». A throw is also a refusal from the attacker's side and is useless
			// from the user's, which is why the status is asserted and not merely the absence of a
			// success.
			expect.assertions(4);
			persist.resolveImportBucketAccountById.mockRejectedValue(
				new persist.ImportBucketAccountError('not-found')
			);
			const result = await submit(WITH_HEADER, true, { accountId });
			expect(result.status).toBe(400);
			expect(result.status).toBeLessThan(500);
			expect(result.data?.error).toBe(m.import_account_error_required());
			// The designations survive the refusal: the user is being asked which account, not
			// asked to designate the columns again.
			expect(result.data?.keepDesignation).toBe(true);
		}
	);

	it('refuses an ARCHIVED account of the user’s own with its OWN sentence', async () => {
		// SEPARATES: « the refusal names what to do about an archived account » FROM « every refusal
		// says the same thing ». They own this one, so telling them it is archived discloses nothing
		// and is the only version that explains why a valid choice was rejected. Sending them back
		// to a panel that does not contain it, with no reason, is the alternative.
		expect.assertions(3);
		persist.resolveImportBucketAccountById.mockRejectedValue(
			new persist.ImportBucketAccountError('archived')
		);
		const result = await submit(WITH_HEADER, true, { accountId: 'archived-account' });
		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(m.import_account_error_archived());
		expect(result.data?.error).not.toBe(m.import_account_error_required());
	});

	it('writes NOTHING on the way to refusing', async () => {
		// SEPARATES: « the refusal happened before any write » FROM « a batch was created and then
		// the request failed ». A refusal that leaves a batch behind is only a refusal from the
		// caller's side, and it is the shape that makes an abandoned run cost the user a row.
		expect.assertions(2);
		persist.resolveImportBucketAccountById.mockRejectedValue(
			new persist.ImportBucketAccountError('not-found')
		);
		await submit(WITH_HEADER, true, { accountId: 'nope' });
		expect(persist.createImportBatch).not.toHaveBeenCalled();
		expect(persist.persistImportedTransactions).not.toHaveBeenCalled();
	});

	it('files the statement into the account the user chose', async () => {
		// The calibration the four refusals above need: without it they are equally explained by a
		// route that refuses everything. SEPARATES « the chosen id reaches the write » FROM « the
		// route ignores it and writes somewhere else ».
		expect.assertions(2);
		persist.resolveImportBucketAccountById.mockResolvedValue({
			accountId: 'account-chosen',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});
		await submit(WITH_HEADER, true, { accountId: 'account-chosen' });
		expect(persist.resolveImportBucketAccountById).toHaveBeenCalledWith({
			userId: 'user-a',
			accountId: 'account-chosen'
		});
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: 'account-chosen' })
		);
	});
});

/**
 * THE READING THE USER ANSWERED, AND WHETHER IT REACHES THE PARSE. #639.
 *
 * ## Why the dates and not a flag
 *
 * The defect this closes is not « an option was dropped ». It is that a user who answered « Mois
 * puis jour » read `4 mars 2026` on the designation row, pressed Importer, and the import stored
 * `2026-04-03`. So every test below asserts the DATES that reached the write, read off
 * `persistImportedTransactions`' own argument, because that is the value a user's money is filed
 * under. A test asserting that the action forwarded a string would pass over a parser that ignored
 * it.
 *
 * `createImportBatch` is asserted beside it: the stored `ImportBatch.dateOrder` is the only record
 * of how a file was read, and a parse that applied one reading while the batch recorded another is
 * a false displayed figure on `/imports`.
 *
 * ## The four tests in the direction this is NOT going
 *
 * An override that could outrank the file's own proof would be worse than no override: a column
 * containing `24/06/2026` PROVES day-first, and honouring an answer there refuses that row loudly
 * and moves every ambiguous row beside it by up to eleven months. `decideDateOrder` holds that
 * precedence and these assert it through the door rather than restating it.
 */
const AMBIGUOUS_OPAQUE = [
	'zone_1,zone_2,zone_3',
	'01/02/2026,Abonnement Fibre Doriane,-39.90',
	'03/02/2026,Primeur Sainte Anne,-17.45',
	'05/02/2026,Remboursement Teleconsultation,49.00'
].join('\n');

/** 24 cannot be a month, so this column PROVES day-first. No answer can outrank a proof. */
const PROVES_DAY_FIRST = [
	'zone_1,zone_2,zone_3',
	'24/06/2026,Abonnement Fibre Doriane,-39.90',
	'01/02/2026,Primeur Sainte Anne,-17.45'
].join('\n');

/** Both readings proved, in one column. Refused, and an answer cannot rescue it. */
const MIXED = [
	'zone_1,zone_2,zone_3',
	'24/06/2026,Abonnement Fibre Doriane,-39.90',
	'06/24/2026,Primeur Sainte Anne,-17.45'
].join('\n');

/** No cell carries the ambiguous grammar, so neither reading can change any parse. */
const ISO_ONLY = [
	'zone_1,zone_2,zone_3',
	'2026-02-01,Abonnement Fibre Doriane,-39.90',
	'2026-02-03,Primeur Sainte Anne,-17.45'
].join('\n');

function datesWritten(): string[] {
	const [input] = persist.persistImportedTransactions.mock.calls[0] as unknown as [
		{ transactions: Array<{ date: string }> }
	];
	return input.transactions.map((transaction) => transaction.date);
}

describe('the reading the user answered decides how the file is read', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 3,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});
		persist.resolveImportBucketAccountById.mockResolvedValue({
			accountId: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});
		persist.createImportBatch.mockResolvedValue('batch-1');
	});

	/**
	 * THE BASELINE, and it is the calibration every test below needs. Separates « the field moved
	 * the dates » from « these dates are what the parser produces whatever it is told », which is
	 * the state this whole describe block was written against.
	 */
	it('reads an unanswered ambiguous column day-first, which is the application default', async () => {
		expect.assertions(2);
		await submit(AMBIGUOUS_OPAQUE, true);
		expect(datesWritten()).toEqual(['2026-02-01', '2026-02-03', '2026-02-05']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
	});

	/**
	 * THE ONE THAT CARRIES THE BAR. Separates « the answer reached the parse » from « the answer
	 * was accepted and discarded », and the two are the same green on any assertion weaker than
	 * the dates themselves.
	 */
	it('reads the column month-first when that is what the user answered', async () => {
		expect.assertions(2);
		await submit(AMBIGUOUS_OPAQUE, true, { dateOrder: 'month-first' });
		expect(datesWritten()).toEqual(['2026-01-02', '2026-03-02', '2026-05-02']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'month-first' })
		);
	});

	/**
	 * Separates « day-first was answered » from « no answer arrived », which produce the identical
	 * dates. Only the STORED reading can tell them apart, and it has to, because the disclosure on
	 * `/imports` states what the import applied.
	 */
	it('reads the column day-first when that is what the user answered', async () => {
		expect.assertions(2);
		await submit(AMBIGUOUS_OPAQUE, true, { dateOrder: 'day-first' });
		expect(datesWritten()).toEqual(['2026-02-01', '2026-02-03', '2026-02-05']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
	});

	/**
	 * A CLOSED SET, POSITIVELY VALIDATED, and a hostile value falls back to the DERIVATION rather
	 * than to an error. ASVS 5.0 v5.0.0-2.2.1, whose text is quoted where the validation lives, in
	 * `domain/dateReading.ts`. It read `v5.0.0-5.1.4` here first, which is not a requirement that
	 * exists.
	 *
	 * Separates « the value was validated against the two readings » from « the string was passed
	 * through ». A parser handed `Mois puis jour` would not match either reading and would read
	 * day-first anyway, so the dates alone cannot tell the two apart: the STORED reading is what
	 * does, because a passed-through string would be recorded as itself.
	 */
	it('ignores a value that is not one of the two readings, and still imports', async () => {
		expect.assertions(3);
		await submit(AMBIGUOUS_OPAQUE, true, { dateOrder: 'Mois puis jour' });
		expect(datesWritten()).toEqual(['2026-02-01', '2026-02-03', '2026-02-05']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
		expect(persist.persistImportedTransactions).toHaveBeenCalledTimes(1);
	});

	/** The empty field, which is what a form posts for an unanswered question. */
	it('ignores an empty field rather than refusing the import', async () => {
		expect.assertions(2);
		await submit(AMBIGUOUS_OPAQUE, true, { dateOrder: '' });
		expect(datesWritten()).toEqual(['2026-02-01', '2026-02-03', '2026-02-05']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
	});

	/**
	 * THE DIRECTION THIS IS NOT GOING. A file that PROVES its order ignores the answer entirely.
	 * `24/06/2026` read month-first is month 24, which is not a date: honouring the answer here
	 * would refuse that row and move `01/02/2026` beside it to 2026-01-02.
	 */
	it('ignores the answer on a column that proves its own order', async () => {
		expect.assertions(2);
		await submit(PROVES_DAY_FIRST, true, { dateOrder: 'month-first' });
		expect(datesWritten()).toEqual(['2026-06-24', '2026-02-01']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
	});

	/**
	 * #619, THROUGH THE ROUTE THAT STILL PRODUCES IT. This door reads `dateOrder` off the form with
	 * no binding to the file, so a request posted by hand (or by a page whose own screen state has
	 * drifted from the file) can pair an answer with a column that proves the other order. The proof
	 * still wins, as the test above asserts; this separates « the summary says the answer was not
	 * applied, naming the proving cell » from « the answer was discarded in silence ».
	 */
	it('tells the user when the file overruled the answer it was posted with', async () => {
		expect.assertions(1);
		const result = (await submit(PROVES_DAY_FIRST, true, { dateOrder: 'month-first' })) as {
			importResult?: { dateOrderDisclosure?: unknown };
		};
		expect(result.importResult?.dateOrderDisclosure).toStrictEqual({
			kind: 'overruled',
			order: 'day-first',
			proof: '24/06/2026'
		});
	});

	/**
	 * THE DIRECTION THIS IS NOT GOING, second half. A column proving BOTH readings has no true
	 * answer to give, so an answer must not rescue it: honouring one would import half the rows
	 * wrong with the user's own choice as the alibi.
	 */
	it('still refuses a column that proves both readings, answer or no answer', async () => {
		expect.assertions(3);
		const result = await submit(MIXED, true, { dateOrder: 'month-first' });
		expect(result.status).toBe(400);
		expect(result.data?.keepDesignation).toBe(true);
		expect(persist.persistImportedTransactions).not.toHaveBeenCalled();
	});

	/**
	 * THE DIRECTION THIS IS NOT GOING, third half. An ISO column has no cell either reading could
	 * disagree about, so the answer applies to nothing and the two readings produce the identical
	 * import. The stored value is the default rather than the answer, which keeps « indistinguishable
	 * » and « answered » from being recorded as the same thing.
	 */
	it('leaves an ISO column untouched by the answer', async () => {
		expect.assertions(2);
		await submit(ISO_ONLY, true, { dateOrder: 'month-first' });
		expect(datesWritten()).toEqual(['2026-02-01', '2026-02-03']);
		expect(persist.createImportBatch).toHaveBeenCalledWith(
			expect.objectContaining({ dateOrder: 'day-first' })
		);
	});
});

/**
 * #485 on the designation door. Correction 2's own finding: this door has no PRIOR mechanism that
 * could have already asked whether a file covers more than one account (it picks a single
 * destination account from a plain list; it never reads the file's own account column), so the
 * fix applies here identically to the auto path, with no suppression flag to draw.
 *
 * The account column here is the file's FOURTH, unmapped column: `dateIndex`/`labelIndex`/
 * `amountIndex` name the first three, and `findDiscriminantColumn` scans every column regardless
 * of which ones are mapped to a role.
 */
describe('a file naming more than one account, on the designation door', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		store.saveColumnMapping.mockResolvedValue({ ok: true as const, id: 'mapping-1' });
		persist.persistImportedTransactions.mockResolvedValue({
			importedRows: 2,
			duplicateRows: 0,
			importedDebitCents: 0,
			importedCreditCents: 0
		});
		persist.resolveImportBucketAccountById.mockResolvedValue({
			accountId: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});
		persist.createImportBatch.mockResolvedValue('batch-1');
	});

	const PROVEN = [
		'date,label,amount,compte',
		'2026-06-01,AUCHAN,-42.10,FR7630001007941234567890185',
		'2026-06-02,SNCF,-30.00,FR3730001007949876543210192'
	].join('\n');
	const UNPROVEN = [
		'date,label,amount,compte',
		'2026-06-01,AUCHAN,-42.10,10000001',
		'2026-06-02,SNCF,-30.00,10000002'
	].join('\n');

	it('refuses outright when the column PROVES two accounts, and writes nothing', async () => {
		expect.assertions(3);
		const result = await submit(PROVEN, true);
		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(refusalLabel({ code: 'multi-account-file', column: 3 }));
		expect(persist.createImportBatch).not.toHaveBeenCalled();
	});

	// #670: this door has no control to answer the ask, so it must not ship the "confirm before
	// importing" sentence with nothing to confirm with. It refuses instead, naming the recourse,
	// which is the OTHER honest outcome `DESIGNATION_CANNOT_REPAIR`'s own principle leaves open
	// (silently dropping the column was the third option, and it reopens #485 on this one door).
	it('refuses with the recourse named, rather than asking a question nothing here can answer', async () => {
		expect.assertions(4);
		const result = await submit(UNPROVEN, true);
		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(
			m.import_error_account_column_unanswerable({ header: 'compte' })
		);
		expect(result.data?.error).not.toBe(m.import_error_ambiguous_account_column());
		expect(persist.createImportBatch).not.toHaveBeenCalled();
	});

	// No dialog exists on this door (#670), so the offer payload that would feed one must not be
	// built either: a payload with nothing to consume it is drafted, not built.
	it('carries no accountColumn offer, since nothing here renders one', async () => {
		expect.assertions(1);
		const result = (await submit(UNPROVEN, true)) as unknown as {
			data?: { accountColumn?: unknown };
		};
		expect(result.data?.accountColumn).toBeUndefined();
	});

	it('imports normally once the column is confirmed to name something else', async () => {
		expect.assertions(2);
		const result = await submit(UNPROVEN, true, { accountColumnAnswer: 'not-account' });
		expect(result.status).toBeUndefined();
		expect(persist.createImportBatch).toHaveBeenCalledTimes(1);
	});

	it('refuses the same way once the column is confirmed to name accounts', async () => {
		expect.assertions(3);
		const result = await submit(UNPROVEN, true, { accountColumnAnswer: 'is-account' });
		expect(result.status).toBe(400);
		expect(result.data?.error).toBe(refusalLabel({ code: 'multi-account-file', column: 3 }));
		expect(persist.createImportBatch).not.toHaveBeenCalled();
	});

	it('leaves an ordinary single-account file untouched', async () => {
		expect.assertions(2);
		const single = [
			'date,label,amount,compte',
			'2026-06-01,AUCHAN,-42.10,FR7630001007941234567890185',
			'2026-06-02,SNCF,-30.00,FR7630001007941234567890185'
		].join('\n');
		const result = await submit(single, true);
		expect(result.status).toBeUndefined();
		expect(persist.createImportBatch).toHaveBeenCalledTimes(1);
	});
});
