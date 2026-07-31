import { describe, expect, it } from 'vitest';
import { backupExportSchema } from './schema';

function buildValidPayload() {
	return {
		formatVersion: 1 as const,
		exportedAt: new Date().toISOString(),
		userEmail: 'user-a@example.test',
		accounts: [{ id: 'acc-1', name: 'Compte courant', currency: 'EUR', source: 'manual' }],
		categories: [{ id: 'cat-1', name: 'Courses' }],
		importBatches: [
			{
				id: 'batch-1',
				source: 'csv',
				fileName: 'releve.csv',
				profile: 'generic',
				rowCount: 1,
				importedRows: 1,
				duplicateRows: 0,
				invalidRows: 0,
				periodStart: null,
				periodEnd: null
			}
		],
		transactions: [
			{
				id: 'tx-1',
				accountId: 'acc-1',
				categoryId: 'cat-1',
				importBatchId: 'batch-1',
				date: new Date('2026-06-15T00:00:00.000Z').toISOString(),
				label: 'Carrefour',
				amountCents: 4_200,
				type: 'expense' as const,
				source: 'csv',
				notes: null,
				bankOperationType: 'CB',
				manualCategory: null,
				natureManual: null,
				dedupeKey: 'dedupe-1',
				metadataJson: null
			}
		],
		monthlyBudgets: [{ id: 'budget-1', categoryName: 'Courses', amountCents: 30_000 }],
		categoryRules: [
			{
				id: 'rule-1',
				name: 'Règle courses',
				matchText: 'carrefour',
				targetCategory: 'Courses',
				targetNature: null,
				enabled: true
			}
		],
		categorizationRules: [
			{
				id: 'legacy-rule-1',
				pattern: 'carrefour',
				targetCategory: 'Courses',
				type: null,
				active: true
			}
		],
		categoryNatureMappings: [
			{ id: 'mapping-1', categoryName: 'Courses', nature: 'spending' as const }
		]
	};
}

describe('backupExportSchema', () => {
	it('accepte un payload valide complet', () => {
		expect.assertions(1);

		const result = backupExportSchema.safeParse(buildValidPayload());

		expect(result.success).toBe(true);
	});

	it('accepte un payload valide avec toutes les listes vides', () => {
		expect.assertions(1);

		const payload = {
			...buildValidPayload(),
			accounts: [],
			categories: [],
			importBatches: [],
			transactions: [],
			monthlyBudgets: [],
			categoryRules: [],
			categorizationRules: [],
			categoryNatureMappings: []
		};

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(true);
	});

	it('rejette un formatVersion différent de 1', () => {
		expect.assertions(1);

		const payload = { ...buildValidPayload(), formatVersion: 2 };

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un champ non déclaré au niveau racine (ex. userId client)', () => {
		expect.assertions(1);

		const payload = { ...buildValidPayload(), userId: 'user-a' };

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un passwordHash injecté sur un objet imbriqué', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts = [{ ...payload.accounts[0], passwordHash: '$2b$12$fake' } as never];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un role injecté sur un objet transaction', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions = [{ ...payload.transactions[0], role: 'ADMIN' } as never];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette une date ISO invalide sur une transaction', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions[0].date = 'pas-une-date';

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un amountCents non entier', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions[0].amountCents = 42.5;

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette une nature de transaction hors énumération', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions[0].natureManual = 'bitcoin' as never;

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un type de transaction hors énumération income/expense', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions[0].type = 'transfer' as never;

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un id de compte vide', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts[0].id = '';

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('accepte un netWorthAccountId absent (compat rétroactive, ancien format sans le lien)', () => {
		expect.assertions(1);

		const result = backupExportSchema.safeParse(buildValidPayload());

		expect(result.success).toBe(true);
	});

	it('accepte un netWorthAccountId null ou renseigné sur un compte', () => {
		expect.assertions(2);

		const withNull = buildValidPayload();
		withNull.accounts = [{ ...withNull.accounts[0], netWorthAccountId: null } as never];

		const withValue = buildValidPayload();
		withValue.accounts = [{ ...withValue.accounts[0], netWorthAccountId: 'nw-acc-1' } as never];

		expect(backupExportSchema.safeParse(withNull).success).toBe(true);
		expect(backupExportSchema.safeParse(withValue).success).toBe(true);
	});

	it('rejette un netWorthAccountId vide sur un compte', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts = [{ ...payload.accounts[0], netWorthAccountId: '' } as never];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un champ forgé injecté aux côtés d’un netWorthAccountId valide (isAdmin)', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts = [
			{ ...payload.accounts[0], netWorthAccountId: 'nw-acc-1', isAdmin: true } as never
		];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un tableau accounts qui n’est pas un tableau', () => {
		expect.assertions(1);

		const payload = { ...buildValidPayload(), accounts: 'not-an-array' };

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('accepte un defaultKey qui est une clé système réelle', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.categories = [{ ...payload.categories[0], defaultKey: 'food' } as never];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(true);
	});

	it('accepte un defaultKey absent ou null (export pré-i18n)', () => {
		expect.assertions(2);

		const withoutKey = buildValidPayload();
		const withNullKey = buildValidPayload();
		withNullKey.categories = [{ ...withNullKey.categories[0], defaultKey: null } as never];

		expect(backupExportSchema.safeParse(withoutKey).success).toBe(true);
		expect(backupExportSchema.safeParse(withNullKey).success).toBe(true);
	});

	it('rejette un defaultKey forgé hors de l’enum des clés système', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.categories = [{ ...payload.categories[0], defaultKey: 'hacked-key' } as never];

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rétrocompatibilité : un ancien fichier sans bankConnections est accepté (défaut [])', () => {
		expect.assertions(2);

		const payload = buildValidPayload();

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.bankConnections).toEqual([]);
		}
	});

	it('accepte un payload dont bankConnections contient une entrée valide (métadonnées non sensibles uniquement)', () => {
		expect.assertions(1);

		const payload = {
			...buildValidPayload(),
			bankConnections: [
				{
					id: 'bank-1',
					provider: 'enablebanking',
					status: 'active' as const,
					consentExpiresAt: new Date('2026-12-01T00:00:00.000Z').toISOString(),
					lastSyncAt: null
				}
			]
		};

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(true);
	});

	it('rejette une entrée bankConnections qui embarque credentialsEncrypted (.strict())', () => {
		expect.assertions(1);

		const payload = {
			...buildValidPayload(),
			bankConnections: [
				{
					id: 'bank-1',
					provider: 'enablebanking',
					status: 'active' as const,
					consentExpiresAt: null,
					lastSyncAt: null,
					credentialsEncrypted: 'iv:tag:secret'
				}
			]
		};

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette une entrée bankConnections qui embarque providerSessionId (.strict())', () => {
		expect.assertions(1);

		const payload = {
			...buildValidPayload(),
			bankConnections: [
				{
					id: 'bank-1',
					provider: 'enablebanking',
					status: 'active' as const,
					consentExpiresAt: null,
					lastSyncAt: null,
					providerSessionId: 'session-secret'
				}
			]
		};

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	it('rejette un status bankConnections hors énumération', () => {
		expect.assertions(1);

		const payload = {
			...buildValidPayload(),
			bankConnections: [
				{
					id: 'bank-1',
					provider: 'enablebanking',
					status: 'pending',
					consentExpiresAt: null,
					lastSyncAt: null
				}
			]
		};

		const result = backupExportSchema.safeParse(payload);

		expect(result.success).toBe(false);
	});

	/**
	 * Les colonnes texte sans override natif valent `varchar(191)` sur MySQL et rien du tout sur
	 * SQLite/PostgreSQL. Une borne Zod au-dessus de 191 rendait donc le résultat d'une restauration
	 * dépendant du moteur : le même fichier passait sur deux providers et échouait à l'insert sur le
	 * troisième. Ce tableau est la contrepartie du commentaire de schemaGenerator.ts — il échoue si
	 * quelqu'un réélargit une de ces bornes, ce qu'aucune relecture du commentaire ne ferait.
	 */
	const portableBounds: ReadonlyArray<
		[string, (payload: ReturnType<typeof buildValidPayload>, value: string) => void]
	> = [
		['Account.source', (p, v) => void (p.accounts[0].source = v)],
		['Category.name', (p, v) => void (p.categories[0].name = v)],
		['ImportBatch.source', (p, v) => void (p.importBatches[0].source = v)],
		['ImportBatch.profile', (p, v) => void (p.importBatches[0].profile = v)],
		['Transaction.source', (p, v) => void (p.transactions[0].source = v)],
		// `manualCategory` is null in the fixture, so TypeScript narrows the property to `null`.
		// The Zod schema types it `string | null`; the assertion re-widens it to what the column
		// actually holds rather than loosening the fixture and weakening every other test.
		[
			'Transaction.manualCategory',
			(p, v) => void ((p.transactions[0] as { manualCategory: string | null }).manualCategory = v)
		],
		['MonthlyBudget.categoryName', (p, v) => void (p.monthlyBudgets[0].categoryName = v)],
		['CategoryRule.name', (p, v) => void (p.categoryRules[0].name = v)],
		['CategoryRule.targetCategory', (p, v) => void (p.categoryRules[0].targetCategory = v)],
		[
			'CategorizationRule.targetCategory',
			(p, v) => void (p.categorizationRules[0].targetCategory = v)
		],
		[
			'CategoryNatureMapping.categoryName',
			(p, v) => void (p.categoryNatureMappings[0].categoryName = v)
		]
	];

	it.each(portableBounds)(
		'%s accepte 191 caractères et rejette 192 (largeur de la colonne la plus étroite)',
		(_column, assign) => {
			expect.assertions(2);

			const atLimit = buildValidPayload();
			assign(atLimit, 'a'.repeat(191));
			const overLimit = buildValidPayload();
			assign(overLimit, 'a'.repeat(192));

			expect(backupExportSchema.safeParse(atLimit).success).toBe(true);
			expect(backupExportSchema.safeParse(overLimit).success).toBe(false);
		}
	);

	it('BankConnection.provider accepte 191 caractères et rejette 192', () => {
		expect.assertions(2);

		const build = (value: string) => ({
			...buildValidPayload(),
			bankConnections: [
				{
					id: 'bank-1',
					provider: value,
					status: 'active' as const,
					consentExpiresAt: null,
					lastSyncAt: null
				}
			]
		});

		expect(backupExportSchema.safeParse(build('a'.repeat(191))).success).toBe(true);
		expect(backupExportSchema.safeParse(build('a'.repeat(192))).success).toBe(false);
	});

	it('NetWorthAccount.name et SavingsGoal.name acceptent 191 caractères et rejettent 192', () => {
		expect.assertions(4);

		const withNetWorth = (name: string) => ({
			...buildValidPayload(),
			netWorthAccounts: [
				{
					id: 'nw-1',
					name,
					type: 'savings' as const,
					balanceCents: 1_000,
					deletedAt: null
				}
			]
		});
		const withGoal = (name: string) => ({
			...buildValidPayload(),
			savingsGoals: [
				{
					id: 'goal-1',
					name,
					targetAmountCents: 100_000,
					netWorthAccountId: null,
					currentAmountCents: 0,
					startingBalanceCents: 0,
					targetDate: null,
					reachedAt: null,
					reachedBannerDismissedAt: null
				}
			]
		});

		expect(backupExportSchema.safeParse(withNetWorth('a'.repeat(191))).success).toBe(true);
		expect(backupExportSchema.safeParse(withNetWorth('a'.repeat(192))).success).toBe(false);
		expect(backupExportSchema.safeParse(withGoal('a'.repeat(191))).success).toBe(true);
		expect(backupExportSchema.safeParse(withGoal('a'.repeat(192))).success).toBe(false);
	});

	/**
	 * La seule borne laissée au-dessus de 191, délibérément : la banque fournit cet uid et la
	 * synchro l'écrit sans le tronquer, donc le resserrer rejetterait l'export d'une install
	 * SQLite ou PostgreSQL au lieu de supprimer une divergence. Voir la note dans schema.ts.
	 */
	it('Account.providerAccountId reste accepté au-delà de 191 caractères', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts = [{ ...payload.accounts[0], providerAccountId: 'a'.repeat(500) } as never];

		expect(backupExportSchema.safeParse(payload).success).toBe(true);
	});

	it('accepte un compte dont bankConnectionId est absent, null ou renseigné', () => {
		expect.assertions(3);

		const absent = buildValidPayload();
		const withNull = buildValidPayload();
		withNull.accounts = [{ ...withNull.accounts[0], bankConnectionId: null } as never];
		const withValue = buildValidPayload();
		withValue.accounts = [{ ...withValue.accounts[0], bankConnectionId: 'bank-1' } as never];

		expect(backupExportSchema.safeParse(absent).success).toBe(true);
		expect(backupExportSchema.safeParse(withNull).success).toBe(true);
		expect(backupExportSchema.safeParse(withValue).success).toBe(true);
	});
});
