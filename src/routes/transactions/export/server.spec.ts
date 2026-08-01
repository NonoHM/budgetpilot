import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		transaction: {
			findMany: vi.fn()
		},
		categoryNatureMapping: {
			findMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { GET } = await import('./+server');

const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

function makeTransaction(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		date: new Date('2026-06-24T00:00:00.000Z'),
		label: 'Courses Auchan',
		amountCents: 3_000,
		type: 'expense',
		source: 'csv',
		manualCategory: null,
		natureManual: null,
		category: { name: 'Alimentation' },
		...overrides
	};
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
		db.prisma.transaction.findMany.mockResolvedValue([]);
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

	it("l'en-tête CSV correspond exactement aux 7 colonnes attendues, dans l'ordre", async () => {
		expect.assertions(1);

		const response = await GET(makeRequest() as never);
		const body = await response.text();

		expect(body.split('\r\n')[0]).toBe(
			'date;libelle;categorie;montant;type;nature;source_bancaire'
		);
	});

	it('un libellé au format injection de formule est préfixé par une apostrophe à l’export', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([makeTransaction({ label: '=cmd|calc!A0' })]);

		const response = await GET(makeRequest() as never);
		const body = await response.text();

		expect(body).toContain("'=cmd|calc!A0");
	});

	it('un libellé contenant ; ou " ou un retour ligne est correctement échappé/quoté', async () => {
		expect.assertions(2);

		db.prisma.transaction.findMany.mockResolvedValue([
			makeTransaction({ label: 'Chèque n°1; "spécial"' })
		]);

		const response = await GET(makeRequest() as never);
		const [, row] = (await response.text()).split('\r\n');

		expect(row).toContain('"Chèque n°1; ""spécial"""');
		expect(row.startsWith('2026-06-24;"Chèque n°1; ""spécial"""')).toBe(true);
	});

	it('la catégorie effective (override manuel) prime sur category.name', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([
			makeTransaction({ manualCategory: 'Loisirs', category: { name: 'Alimentation' } })
		]);

		const response = await GET(makeRequest() as never);
		const [, row] = (await response.text()).split('\r\n');

		expect(row.split(';')[2]).toBe('Loisirs');
	});

	it('filtre par recherche libellé, insensible à la casse et aux accents', async () => {
		expect.assertions(1);

		db.prisma.transaction.findMany.mockResolvedValue([
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

	it('la nature effective priorise natureManual puis le mapping catégorie puis le défaut', async () => {
		expect.assertions(3);

		db.prisma.transaction.findMany.mockResolvedValue([
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
