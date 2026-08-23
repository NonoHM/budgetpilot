import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSACTION_CSV_HEADER } from '$lib/server/transactions/exportCsv';

const db = vi.hoisted(() => ({
	prisma: {
		transaction: {
			findMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn()
		},
		/**
		 * Added when the route began naming the account its rows came from.
		 *
		 * It THROWS on any where clause it cannot model rather than answering null, because a fake
		 * that silently ignores a predicate makes « the route scoped by userId » and « the fake
		 * returned nothing » the same green, which is the exact failure the IDOR battery is a
		 * `db-smoke` to avoid. What this route's own `compte` column does is asserted against a real
		 * engine in `exportAccountColumn.db-smoke.ts`; here the model only has to exist so the fixtures
		 * below keep measuring what they name.
		 */
		account: {
			findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) => {
				if (!where || typeof where.userId !== 'string' || typeof where.id !== 'string') {
					throw new Error(
						`the export spec's account fake cannot model this where clause: ${JSON.stringify(where)}`
					);
				}
				return null;
			})
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { GET } = await import('./+server');

const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

function makeTransaction(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'transaction-1',
		date: new Date('2026-06-24T00:00:00.000Z'),
		label: 'Courses Auchan',
		amountCents: 3_000,
		type: 'expense',
		source: 'csv',
		manualCategory: null,
		natureManual: null,
		category: { name: 'Alimentation' },
		splits: [],
		...overrides
	};
}

/**
 * Answers `findMany` through the select the route actually passed, instead of handing back the
 * fixture whole.
 *
 * A fake that ignores `select` cannot tell a route that reads parts from one that does not: drop
 * `splits` from the export's select and every test here would still see the fixture's parts and
 * still go green, while the shipped CSV lost every répartition. Same defect class as the
 * `updateMany` matcher in page.server.spec.ts — and the same remedy, which is to REFUSE rather
 * than to approximate.
 */
function respondWith(rows: Array<Record<string, unknown>>) {
	db.prisma.transaction.findMany.mockImplementation(
		({ select }: { select?: Record<string, unknown> }) => {
			if (!select?.splits) {
				throw new Error(
					'the export must select `splits` — without them every répartition exports as its parent'
				);
			}
			return Promise.resolve(
				rows.map((row) =>
					Object.fromEntries(Object.keys(select).map((column) => [column, row[column]]))
				)
			);
		}
	);
}

function makeRequest(query = '') {
	return {
		locals: { user: testUser },
		url: new URL(`http://localhost/transactions/export${query}`)
	};
}

describe('GET /transactions/export', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		respondWith([]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([]);
	});

	it("refuse l'accès sans utilisateur connecté et ne requête jamais la base", async () => {
		expect.assertions(2);

		await expect(
			GET({ locals: { user: null }, url: new URL('http://localhost/transactions/export') } as never)
		).rejects.toBeTruthy();
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	it('scope la requête sur le userId courant', async () => {
		expect.assertions(1);

		await GET(makeRequest() as never);

		expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ userId: 'user-a' }) })
		);
	});

	it('un importBatch/category forgé ne permet pas de sortir du scope userId', async () => {
		expect.assertions(2);

		await GET(makeRequest('?importBatch=other-user-batch12&category=Alimentation') as never);

		const callArgs = db.prisma.transaction.findMany.mock.calls[0][0];
		expect(callArgs.where.userId).toBe('user-a');
		// The category sub-filter stays nested under the requester's userId, not an arbitrary userId.
		expect(callArgs.where.OR[1].AND[1].category.is.userId).toBe('user-a');
	});

	// The export MUST honour ?ids=. It is a download of "what I'm looking at" with no visible
	// result to compare against, and the file leaves the machine — an export that silently widened
	// to the whole history would ship it to whoever the CSV is mailed to.
	describe('filtre ?ids=', () => {
		it('restreint l’export aux ids demandés, toujours sous le scope userId', async () => {
			expect.assertions(1);

			await GET(makeRequest('?ids=transaction-1,transaction-2') as never);

			expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						userId: 'user-a',
						id: { in: ['transaction-1', 'transaction-2'] }
					})
				})
			);
		});

		it('n’exporte RIEN plutôt que tout l’historique quand les ids sont tous malformés', async () => {
			expect.assertions(1);

			await GET(makeRequest('?ids=short,%27%3B%20DROP%20TABLE') as never);

			expect(db.prisma.transaction.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ userId: 'user-a', id: { in: [] } })
				})
			);
		});

		it('borne la liste avant de la passer à Prisma', async () => {
			expect.assertions(1);

			const overLong = Array.from({ length: 2_000 }, (_, i) => `transaction-${i}`).join(',');
			await GET(makeRequest(`?ids=${overLong}`) as never);

			const callArgs = db.prisma.transaction.findMany.mock.calls[0][0];

			expect(callArgs.where.id.in.length).toBeLessThanOrEqual(250);
		});

		it('n’ajoute aucun filtre d’id quand le paramètre est absent', async () => {
			expect.assertions(1);

			await GET(makeRequest('?type=income') as never);

			expect(db.prisma.transaction.findMany.mock.calls[0][0].where).not.toHaveProperty('id');
		});
	});

	it('le Content-Type est du CSV et le Content-Disposition propose un fichier .csv en pièce jointe', async () => {
		expect.assertions(3);

		const response = await GET(makeRequest() as never);

		expect(response.headers.get('Content-Type')).toContain('text/csv');
		expect(response.headers.get('Content-Disposition')).toContain('attachment');
		expect(response.headers.get('Content-Disposition')).toContain('.csv');
	});

	// The header is asserted against the CONSTANT rather than against a retyped literal, which is
	// the change this test needed when the export gained its account column. A literal here and a
	// literal in `exportCsv.ts` are two sources for one string, and the version 3 addition proved
	// it: the constant moved, this spec did not, and the failure named a count (« 7 colonnes »)
	// that had not been true of this line for several versions.
	//
	// SEPARATES: « the route serves the export's real header » FROM « the route serves some header
	// that happens to start the same way ». `toBe` against the constant, never `toContain`.
	it("l'en-tête CSV servi par la route est exactement la constante d'export", async () => {
		expect.assertions(2);

		const response = await GET(makeRequest() as never);
		const body = await response.text();

		expect(body.split('\r\n')[0]).toBe(TRANSACTION_CSV_HEADER);
		// Calibration beside the identity: the constant is a real header rather than an empty
		// string, so the assertion above cannot pass by both sides being nothing.
		expect(TRANSACTION_CSV_HEADER.split(';').length).toBeGreaterThan(5);
	});

	it('un libellé au format injection de formule est préfixé par une apostrophe à l’export', async () => {
		expect.assertions(1);

		respondWith([makeTransaction({ label: '=cmd|calc!A0' })]);

		const response = await GET(makeRequest() as never);
		const body = await response.text();

		expect(body).toContain("'=cmd|calc!A0");
	});

	it('un libellé contenant ; ou " ou un retour ligne est correctement échappé/quoté', async () => {
		expect.assertions(2);

		respondWith([makeTransaction({ label: 'Chèque n°1; "spécial"' })]);

		const response = await GET(makeRequest() as never);
		const [, row] = (await response.text()).split('\r\n');

		expect(row).toContain('"Chèque n°1; ""spécial"""');
		expect(row.startsWith('2026-06-24;"Chèque n°1; ""spécial"""')).toBe(true);
	});

	it('la catégorie effective (override manuel) prime sur category.name', async () => {
		expect.assertions(1);

		respondWith([
			makeTransaction({ manualCategory: 'Loisirs', category: { name: 'Alimentation' } })
		]);

		const response = await GET(makeRequest() as never);
		const [, row] = (await response.text()).split('\r\n');

		expect(row.split(';')[2]).toBe('Loisirs');
	});

	it('filtre par recherche libellé, insensible à la casse et aux accents', async () => {
		expect.assertions(1);

		respondWith([
			makeTransaction({ label: 'Dépenses courantes' }),
			makeTransaction({ label: 'Salaire' })
		]);

		const response = await GET(makeRequest('?q=depenses') as never);
		const rows = (await response.text()).split('\r\n').slice(1);

		expect(rows).toHaveLength(1);
	});

	it('renvoie 400 pour une regex invalide en qMode=regex, sans exposer le pattern brut', async () => {
		expect.assertions(2);

		await expect(GET(makeRequest('?q=(&qMode=regex') as never)).rejects.toBeTruthy();
		expect(db.prisma.transaction.findMany).not.toHaveBeenCalled();
	});

	// Characterization of the error contract, pinned BEFORE the export is routed through
	// resolveTransactionScope, so the refactor cannot silently change status/message/precedence.
	describe('contrat d’erreur (caractérisation, avant migration vers resolveTransactionScope)', () => {
		it('renvoie 400 pour une plage de dates inutilisable, sous toutes ses formes', async () => {
			expect.assertions(3);

			await expect(GET(makeRequest('?from=2026-01-01') as never)).rejects.toMatchObject({
				status: 400
			});
			await expect(
				GET(makeRequest('?from=2026-99-99&to=2026-12-31') as never)
			).rejects.toMatchObject({ status: 400 });
			await expect(
				GET(makeRequest('?from=2026-12-31&to=2026-01-01') as never)
			).rejects.toMatchObject({ status: 400 });
		});

		it('renvoie 400 avec le message de plage de dates (pas le message regex)', async () => {
			expect.assertions(1);

			await expect(GET(makeRequest('?from=2026-01-01') as never)).rejects.toMatchObject({
				status: 400,
				body: { message: 'Période personnalisée invalide' }
			});
		});

		it('renvoie 400 avec le message de regex invalide quand seule la regex est fautive', async () => {
			expect.assertions(1);

			await expect(GET(makeRequest('?q=%5B&qMode=regex') as never)).rejects.toMatchObject({
				status: 400,
				body: { message: 'Expression régulière invalide.' }
			});
		});

		it('quand la plage ET la regex sont invalides, le message de plage l’emporte', async () => {
			expect.assertions(1);

			await expect(
				GET(makeRequest('?from=2026-99-99&to=2026-12-31&q=%5B&qMode=regex') as never)
			).rejects.toMatchObject({
				status: 400,
				body: { message: 'Période personnalisée invalide' }
			});
		});
	});

	it('la nature effective priorise natureManual puis le mapping catégorie puis le défaut', async () => {
		expect.assertions(3);

		respondWith([
			makeTransaction({ natureManual: 'fee', category: { name: 'Alimentation' } }),
			makeTransaction({
				label: 'Virement épargne',
				natureManual: null,
				category: { name: 'Épargne' }
			}),
			makeTransaction({ label: 'Achat divers', natureManual: null, category: { name: 'Divers' } })
		]);
		db.prisma.categoryNatureMapping.findMany.mockResolvedValue([
			{ categoryName: 'Épargne', nature: 'investment' }
		]);

		const response = await GET(makeRequest() as never);
		const rows = (await response.text()).split('\r\n').slice(1);
		const natureOf = (row: string) => row.split(';')[5];

		expect(natureOf(rows[0])).toBe('fee');
		expect(natureOf(rows[1])).toBe('investment');
		expect(natureOf(rows[2])).toBe('spending');
	});
});
