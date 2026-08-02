import { describe, expect, it } from 'vitest';
import {
	backupExportSchema,
	MAX_ANCHOR_IDS,
	MAX_ANCHOR_CELL_CHARS,
	MAX_IMPORTED_RECURRING_STREAM_ACTIONS,
	MAX_RECURRING_STREAM_ACTIONS,
	parseAnchorTransactionIds
} from './schema';
import { MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';

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
		],
		tags: [{ id: 'file-tag-1', name: 'Portugal', colorToken: 'tag-1' as string }],
		transactionTags: [] as Array<{ transactionId: string; tagId: string }>
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
		],
		['Tag.name', (p, v) => void (p.tags[0].name = v)]
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

	// Same shape as the SavingsGoal case above rather than a row in `portableBounds`:
	// `buildValidPayload()` carries no `recurringStreamActions` array (the field defaults to `[]`,
	// which is what the back-compat test below asserts), so the fixture is built per case here.
	const buildActionPayload = (overrides: Record<string, unknown> = {}) => ({
		...buildValidPayload(),
		recurringStreamActions: [
			{
				id: 'action-1',
				kind: 'IGNORE' as const,
				direction: 'expense' as const,
				normalizedLabel: 'edf',
				label: 'EDF',
				anchorTransactionIds: JSON.stringify(['tx-1']),
				dueDate: new Date('2026-08-05T00:00:00.000Z').toISOString(),
				createdAt: new Date('2026-07-31T00:00:00.000Z').toISOString(),
				updatedAt: new Date('2026-07-31T00:00:00.000Z').toISOString(),
				...overrides
			}
		]
	});

	it.each([['normalizedLabel'], ['label']])(
		'RecurringStreamAction.%s accepte 191 caractères et rejette 192',
		(field) => {
			expect.assertions(2);

			const atLimit = buildActionPayload({ [field]: 'a'.repeat(191) });
			const overLimit = buildActionPayload({ [field]: 'a'.repeat(192) });

			expect(backupExportSchema.safeParse(atLimit).success).toBe(true);
			expect(backupExportSchema.safeParse(overLimit).success).toBe(false);
		}
	);

	/**
	 * Bounded well above 191 on purpose: the column carries a `@db.Text` override, so the
	 * narrowest provider stores it as `text` like the others. Asserted so that narrowing it to
	 * MAX_PORTABLE_STRING — which would reject an ordinary weekly stream's anchor list — goes red.
	 */
	it('RecurringStreamAction.anchorTransactionIds est accepté au-delà de 191 caractères', () => {
		expect.assertions(2);

		const ids = Array.from({ length: 52 }, (_, index) => `tx-${index}`);
		const serialized = JSON.stringify(ids);
		expect(serialized.length).toBeGreaterThan(191);

		expect(
			backupExportSchema.safeParse(buildActionPayload({ anchorTransactionIds: serialized })).success
		).toBe(true);
	});

	/**
	 * Availability bound, not an integrity one. Every transaction an action anchors leaves the
	 * bulk `createMany` for its own `create` inside the single interactive transaction, so an
	 * unbounded list lets a small hand-edited file hold a pooled connection for the whole
	 * LONG_TRANSACTION_OPTIONS ceiling.
	 */
	it('rejette un fichier au-delà de MAX_IMPORTED_RECURRING_STREAM_ACTIONS', () => {
		expect.assertions(4);

		const build = (count: number) => ({
			...buildValidPayload(),
			recurringStreamActions: Array.from({ length: count }, (_, index) => ({
				...buildActionPayload().recurringStreamActions[0],
				id: `action-${index}`
			}))
		});

		expect(backupExportSchema.safeParse(build(MAX_IMPORTED_RECURRING_STREAM_ACTIONS)).success).toBe(
			true
		);
		expect(
			backupExportSchema.safeParse(build(MAX_IMPORTED_RECURRING_STREAM_ACTIONS + 1)).success
		).toBe(false);

		// The gap that keeps a user's own export restorable: the write path refuses past
		// MAX_RECURRING_STREAM_ACTIONS, but a concurrent count-then-insert can overshoot it by a
		// little, and an import bound equal to the write cap would turn that race into a permanent
		// restore failure. Anything in the gap must still validate.
		expect(MAX_IMPORTED_RECURRING_STREAM_ACTIONS).toBeGreaterThan(MAX_RECURRING_STREAM_ACTIONS);
		expect(backupExportSchema.safeParse(build(MAX_RECURRING_STREAM_ACTIONS + 1)).success).toBe(
			true
		);
	});

	/**
	 * The cell bound and the write-path cap are a pair: the restore rewrites this column with
	 * freshly generated 25-char cuids, so a cell of MAX_ANCHOR_IDS of them must still be
	 * something this schema accepts. Asserted here as well as against the real write path, so
	 * narrowing the cell bound alone goes red.
	 */
	it('accepte une cellule pleine de MAX_ANCHOR_IDS cuids', () => {
		expect.assertions(2);

		expect(MAX_ANCHOR_IDS * 28 + 2).toBeLessThanOrEqual(MAX_ANCHOR_CELL_CHARS);

		const full = JSON.stringify(Array.from({ length: MAX_ANCHOR_IDS }, () => 'c'.repeat(25)));

		expect(
			backupExportSchema.safeParse(buildActionPayload({ anchorTransactionIds: full })).success
		).toBe(true);
	});

	it('rejette une action portant un champ non déclaré (strict)', () => {
		expect.assertions(2);

		const smuggled = buildActionPayload({ userId: 'other-user' });
		const unknownKind = buildActionPayload({ kind: 'DELETE' });

		expect(backupExportSchema.safeParse(smuggled).success).toBe(false);
		expect(backupExportSchema.safeParse(unknownKind).success).toBe(false);
	});

	it('accepte un payload sans recurringStreamActions (export antérieur à la fonctionnalité)', () => {
		expect.assertions(2);

		const result = backupExportSchema.safeParse(buildValidPayload());

		expect(result.success).toBe(true);
		expect(result.success && result.data.recurringStreamActions).toStrictEqual([]);
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

describe('parseAnchorTransactionIds', () => {
	it('lit un tableau JSON de chaînes non vides', () => {
		expect.assertions(1);

		expect(parseAnchorTransactionIds(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
	});

	it('rend une liste vide sur du JSON illisible ou non-tableau', () => {
		expect.assertions(3);

		expect(parseAnchorTransactionIds('not json')).toEqual([]);
		expect(parseAnchorTransactionIds('{"a":1}')).toEqual([]);
		expect(parseAnchorTransactionIds('"a"')).toEqual([]);
	});

	it('filtre les éléments qui ne sont pas des chaînes non vides', () => {
		expect.assertions(1);

		expect(parseAnchorTransactionIds('["ok", 42, "", null, "aussi"]')).toEqual(['ok', 'aussi']);
	});
});

describe('tags', () => {
	it('defaults both tag arrays to empty so an older export still restores', () => {
		expect.assertions(3);

		const payload = buildValidPayload() as Record<string, unknown>;
		delete payload.tags;
		delete payload.transactionTags;

		const parsed = backupExportSchema.safeParse(payload);

		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.tags).toEqual([]);
			expect(parsed.data.transactionTags).toEqual([]);
		}
	});

	it('rejects a colorToken outside the closed palette set', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.tags = [{ id: 'file-tag-1', name: 'Portugal', colorToken: 'tag-99' }];

		expect(backupExportSchema.safeParse(payload).success).toBe(false);
	});

	it('rejects a raw hex smuggled in as a colorToken', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.tags = [{ id: 'file-tag-1', name: 'Portugal', colorToken: '#ff0000' }];

		expect(backupExportSchema.safeParse(payload).success).toBe(false);
	});

	it('rejects an undeclared field on a tag', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.tags = [
			{ id: 'file-tag-1', name: 'Portugal', colorToken: 'tag-1', userId: 'someone-else' } as never
		];

		expect(backupExportSchema.safeParse(payload).success).toBe(false);
	});

	it('accepts a pair array within the relative bound', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		// One transaction in the fixture, so the ceiling is MAX_TAGS_PER_TRANSACTION pairs.
		payload.transactionTags = Array.from({ length: MAX_TAGS_PER_TRANSACTION }, (_, i) => ({
			transactionId: payload.transactions[0].id,
			tagId: `file-tag-${i}`
		}));

		expect(backupExportSchema.safeParse(payload).success).toBe(true);
	});

	it('rejects a pair array amplified beyond what the transactions could legally carry', () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactionTags = Array.from({ length: MAX_TAGS_PER_TRANSACTION + 1 }, (_, i) => ({
			transactionId: payload.transactions[0].id,
			tagId: `file-tag-${i}`
		}));

		expect(backupExportSchema.safeParse(payload).success).toBe(false);
	});

	it('scales the relative bound with the number of transactions, refusing nothing legal', () => {
		expect.assertions(2);

		// Two transactions doubles the ceiling. An absolute bound could not do this without
		// either refusing a legal export or leaving an amplification through.
		const payload = buildValidPayload();
		payload.transactions = [
			payload.transactions[0],
			{ ...payload.transactions[0], id: 'tx-2', dedupeKey: 'dedupe-2' }
		];
		payload.transactionTags = Array.from({ length: MAX_TAGS_PER_TRANSACTION * 2 }, (_, i) => ({
			transactionId: 'tx-1',
			tagId: `file-tag-${i}`
		}));

		expect(backupExportSchema.safeParse(payload).success).toBe(true);

		payload.transactionTags.push({ transactionId: 'tx-1', tagId: 'file-tag-overflow' });
		expect(backupExportSchema.safeParse(payload).success).toBe(false);
	});
});
