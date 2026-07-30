import { existsSync } from 'node:fs';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { buildMaisonDeduplicationKey } from '$lib/server/import/utils/safety';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash } from '$lib/server/import/dedupeKey';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
	type Account = {
		id: string;
		userId: string;
		name: string;
		source: string;
		currency: string;
		netWorthAccountId?: string | null;
		providerAccountId?: string | null;
	};
	type NetWorthAccount = {
		id: string;
		userId: string;
		name: string;
		type: string;
		balanceCents: number;
		deletedAt: Date | null;
		createdAt: Date;
	};
	type Category = { id: string; userId: string; name: string };
	type Batch = {
		id: string;
		userId: string;
		source: string;
		fileName?: string | null;
		profile: string;
		rowCount: number;
		importedRows: number;
		duplicateRows: number;
		invalidRows: number;
		periodStart?: Date | null;
		periodEnd?: Date | null;
	};
	type Rule = {
		id: string;
		pattern: string;
		targetCategory: string;
		type: string | null;
		active: boolean;
		createdAt: Date;
	};
	type Transaction = {
		id: string;
		accountId: string;
		categoryId: string;
		importBatchId: string;
		userId: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string;
		source: string;
		notes: string | null;
		manualCategory: string | null;
		natureManual: string | null;
		dedupeKey: string | null;
		dedupeKeyHash: string | null;
		metadataJson: string | null;
	};
	type AccountUpsertArgs = {
		where: { userId_name_source: { userId: string; name: string; source: string } };
		create: Omit<Account, 'id'>;
		update: Record<string, never>;
	};
	type BatchCreateArgs = {
		data: Partial<Omit<Batch, 'id'>> & Pick<Batch, 'userId' | 'source' | 'rowCount'>;
	};
	type CategoryUpsertArgs = {
		where: { userId_nameKey: { userId: string; nameKey: string } };
		create: Omit<Category, 'id'>;
	};
	type TransactionFindFirstArgs = { where: { userId: string; dedupeKeyHash: string } };
	type TransactionCreateArgs = {
		data: Omit<Transaction, 'id' | 'manualCategory'> & { manualCategory?: string | null };
	};

	const state = {
		accounts: [] as Account[],
		categories: [] as Category[],
		batches: [] as Batch[],
		rules: [] as Rule[],
		transactions: [] as Transaction[],
		netWorthAccounts: [] as NetWorthAccount[],
		nextId: 1
	};

	function id(prefix: string) {
		const value = `${prefix}-${state.nextId}`;
		state.nextId += 1;
		return value;
	}

	return {
		state,
		reset() {
			state.accounts = [];
			state.categories = [];
			state.batches = [];
			state.rules = [];
			state.transactions = [];
			state.netWorthAccounts = [];
			state.nextId = 1;
		},
		prisma: {
			netWorthAccount: {
				findMany: vi.fn(async ({ where }: { where: { userId: string; deletedAt: null } }) =>
					state.netWorthAccounts
						.filter((account) => account.userId === where.userId && account.deletedAt === null)
						.map((account) => ({ ...account, updatedAt: account.createdAt }))
				)
			},
			account: {
				upsert: vi.fn(async ({ where, create }: AccountUpsertArgs) => {
					const found = state.accounts.find(
						(account) =>
							account.userId === where.userId_name_source.userId &&
							account.name === where.userId_name_source.name &&
							account.source === where.userId_name_source.source
					);
					if (found) return found;
					const account = { id: id('account'), ...create };
					state.accounts.push(account);
					return account;
				}),
				findMany: vi.fn(
					async ({
						where
					}: {
						where: { userId: string; name: string; source: { in: string[] } };
					}) =>
						state.accounts.filter(
							(account) =>
								account.userId === where.userId &&
								account.name === where.name &&
								where.source.in.includes(account.source)
						)
				),
				findUnique: vi.fn(
					async ({
						where
					}: {
						where: { userId_name_source: { userId: string; name: string; source: string } };
					}) =>
						state.accounts.find(
							(account) =>
								account.userId === where.userId_name_source.userId &&
								account.name === where.userId_name_source.name &&
								account.source === where.userId_name_source.source
						) ?? null
				),
				// Two distinct lookups share findFirst: the bank-sync one keyed on
				// providerAccountId, and the bucket-name one keyed on the folded nameKey.
				findFirst: vi.fn(
					async ({
						where
					}: {
						where: {
							userId: string;
							source: string;
							nameKey?: string;
							providerAccountId?: string;
						};
					}) =>
						state.accounts.find(
							(account) =>
								account.userId === where.userId &&
								account.source === where.source &&
								(where.nameKey === undefined
									? true
									: computeNameKey(account.name) === where.nameKey) &&
								(where.providerAccountId === undefined
									? true
									: account.providerAccountId === where.providerAccountId)
						) ?? null
				)
			},
			importBatch: {
				create: vi.fn(async ({ data }: BatchCreateArgs) => {
					const batch = {
						id: id('batch'),
						fileName: null,
						profile: 'generic',
						importedRows: 0,
						duplicateRows: 0,
						invalidRows: 0,
						periodStart: null,
						periodEnd: null,
						...data
					};
					state.batches.push(batch);
					return batch;
				}),
				update: vi.fn(async ({ where, data }) => {
					const batch = state.batches.find((item) => item.id === where.id);
					if (!batch) throw new Error('batch not found');
					Object.assign(batch, data);
					return batch;
				})
			},
			categorizationRule: {
				findMany: vi.fn(async () => state.rules.filter((rule) => rule.active))
			},
			categoryRule: {
				findMany: vi.fn(async () =>
					state.rules
						.filter((rule) => rule.active && rule.id.startsWith('category-rule'))
						.map((rule) => ({
							id: rule.id,
							name: rule.pattern,
							matchText: rule.pattern,
							targetCategory: rule.targetCategory,
							enabled: true
						}))
				)
			},
			category: {
				findFirst: vi.fn(async ({ where }: { where: { userId: string; nameKey: string } }) => {
					return (
						state.categories.find(
							(category) =>
								category.userId === where.userId && computeNameKey(category.name) === where.nameKey
						) ?? null
					);
				}),
				upsert: vi.fn(async ({ where, create }: CategoryUpsertArgs) => {
					// Keyed on the folded name, matching the unique constraint the real table
					// carries: two spellings of one category resolve to the same row.
					const found = state.categories.find(
						(category) =>
							category.userId === where.userId_nameKey.userId &&
							computeNameKey(category.name) === where.userId_nameKey.nameKey
					);
					if (found) return found;
					const category = { id: id('category'), ...create };
					state.categories.push(category);
					return category;
				})
			},
			transaction: {
				findFirst: vi.fn(async ({ where }: TransactionFindFirstArgs) => {
					// Matched on the hash, like the real duplicate pre-check: the raw key is the
					// comparison that column exists to replace.
					return (
						state.transactions.find(
							(transaction) =>
								transaction.userId === where.userId &&
								transaction.dedupeKeyHash === where.dedupeKeyHash
						) ?? null
					);
				}),
				create: vi.fn(async ({ data }: TransactionCreateArgs) => {
					if (
						data.dedupeKey &&
						state.transactions.some((transaction) => transaction.dedupeKey === data.dedupeKey)
					) {
						const error = new Error('Unique constraint failed') as Error & { code: string };
						error.code = 'P2002';
						throw error;
					}
					const transaction = { id: id('transaction'), manualCategory: null, ...data };
					state.transactions.push(transaction);
					return transaction;
				}),
				findMany: vi.fn(async ({ where }) => {
					return state.transactions.filter(
						(transaction) =>
							transaction.userId === where.userId &&
							transaction.manualCategory === null &&
							(!where.id?.in || where.id.in.includes(transaction.id))
					);
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					const ids = where.id?.in ?? (where.id ? [where.id] : []);
					let count = 0;
					for (const transaction of state.transactions) {
						if (!ids.includes(transaction.id)) continue;
						if (transaction.userId !== where.userId) continue;
						if (transaction.manualCategory !== where.manualCategory) continue;
						if ('natureManual' in where && transaction.natureManual !== where.natureManual)
							continue;
						transaction.manualCategory = data.manualCategory;
						if ('natureManual' in data) transaction.natureManual = data.natureManual;
						count += 1;
					}
					return { count };
				})
			}
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const BANQUE_POPULAIRE_HEADER =
	'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';

const BANQUE_POPULAIRE_VALID_ROW =
	'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarché;42,90;;23/06/2026;24/06/2026;0';

const AUCHAN_ROW =
	'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;-38,46;;23/06/2026;23/06/2026;0';
const REVOLUT_HEADER =
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
const MAISON_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

describe('/import load', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	it('hasAllImportBucketsExisting: false quand aucun bucket CSV n’existe encore pour cet utilisateur', async () => {
		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it('hasAllImportBucketsExisting reste false quand SEUL un des trois profils a déjà un bucket (régression F7 : le sélecteur doit rester visible pour un profil jamais importé)', async () => {
		db.state.accounts.push({
			id: 'account-existing',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'revolut',
			currency: 'EUR'
		});

		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it("hasAllImportBucketsExisting: false pour un bucket d'un autre utilisateur (pas de fuite cross-user)", async () => {
		db.state.accounts.push({
			id: 'account-other-user',
			userId: 'user-b',
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR'
		});

		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it('hasAllImportBucketsExisting: false quand deux des trois profils ont un bucket mais pas le troisième (csv + revolut, pas banque_populaire)', async () => {
		db.state.accounts.push(
			{
				id: 'account-csv',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'csv',
				currency: 'EUR'
			},
			{
				id: 'account-revolut',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'revolut',
				currency: 'EUR'
			}
		);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
		expect(db.prisma.account.findMany).toHaveBeenCalledWith({
			where: {
				userId: testUser.id,
				name: 'Compte import CSV',
				source: { in: ['csv', 'revolut', 'banque_populaire'] }
			},
			select: { source: true }
		});
	});

	it('hasAllImportBucketsExisting: true quand les trois profils (csv, revolut, banque_populaire) ont déjà un bucket', async () => {
		db.state.accounts.push(
			{
				id: 'account-csv',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'csv',
				currency: 'EUR'
			},
			{
				id: 'account-revolut',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'revolut',
				currency: 'EUR'
			},
			{
				id: 'account-bp',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'banque_populaire',
				currency: 'EUR'
			}
		);

		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(true);
	});

	it('hasAllImportBucketsExisting: false pour un bucket manuel (source différente, non-import)', async () => {
		db.state.accounts.push({
			id: 'account-manual',
			userId: testUser.id,
			name: 'Compte manuel',
			source: 'manual',
			currency: 'EUR'
		});

		const result = (await load({ locals: { user: testUser } } as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});
});

describe('/import actions', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	it('refuse un import sans fichier', async () => {
		expect.assertions(2);

		const result = await runImport(new FormData());

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Sélectionnez un fichier de relevé à importer.');
	});

	it('rejects an unsupported file', async () => {
		expect.assertions(2);

		const formData = new FormData();
		formData.set('csvFile', new File(['not csv'], 'export.txt', { type: 'text/plain' }));

		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Le fichier doit utiliser l’extension .csv ou .xlsx.');
	});

	it('importe un CSV Banque Populaire valide', async () => {
		expect.assertions(7);

		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(result.importResult.profile).toBe('banque-populaire');
		expect(result.importResult.totalRows).toBe(1);
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.invalidRows).toBe(0);
		expect(result.importResult.totalDebitCents).toBe(4_290);
		expect(db.state.transactions).toHaveLength(1);
		expect(db.state.transactions[0]).toMatchObject({
			label: 'CARREFOUR',
			amountCents: 4_290,
			type: 'expense',
			source: 'banque_populaire'
		});
	});

	it('imports AUCHAN Debit -38,46 as a 3846-cent expense', async () => {
		expect.assertions(7);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW}`);
		const transaction = db.state.transactions[0];
		const metadata = JSON.parse(transaction.metadataJson ?? '{}') as {
			reference?: string;
			csvFields?: Record<string, string>;
		};

		expect(transaction.label).toBe('AUCHAN');
		expect(transaction.amountCents).toBe(3_846);
		expect(transaction.type).toBe('expense');
		expect(transaction.notes).toContain('AUCHAN 0065 SC 78MAUREPAS');
		expect(metadata.reference).toBe('80FDBFG');
		expect(metadata.csvFields?.['Libelle operation']).toBe('AUCHAN 0065 SC 78…');
		expect(metadata.csvFields?.['Informations complementaires']).not.toContain('2593');
	});

	it('creates the category if it is absent', async () => {
		expect.assertions(2);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW}`);

		// Without a categorization rule, the persisted category is 'Non catégorisé'.
		// The BP operation type ('Alimentation') is in metadata.banquePopulaireCategory.
		expect(db.state.categories).toHaveLength(1);
		expect(db.state.categories[0].name).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('importe normalement une ligne Banque Populaire Transaction exclue / Virement interne', async () => {
		expect.assertions(6);

		await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n` +
				'22/06/2026;+M PAUL PAUL;VIR M PAUL PAUL;REFVIR;Vir. vers Compte Cheque-;Virement recu;Transaction exclue;Virement interne;;+150,00;20/06/2026;20/06/2026;0'
		);
		const transaction = db.state.transactions[0];
		const metadata = JSON.parse(transaction.metadataJson ?? '{}') as {
			banquePopulaireCategory?: string;
			subcategory?: string;
		};

		expect(db.state.transactions).toHaveLength(1);
		expect(transaction.categoryId).toBe(db.state.categories[0].id);
		// Without a rule, category is 'Non catégorisé'. The BP operation type stays in metadata.
		expect(db.state.categories[0].name).toBe(UNCLASSIFIED_CATEGORY);
		expect(transaction.type).toBe('income');
		expect(metadata.banquePopulaireCategory).toBe('Transaction exclue');
		expect(metadata.subcategory).toBe('Virement interne');
	});

	it('applies a categorization rule during import', async () => {
		expect.assertions(2);

		db.state.rules.push({
			id: 'rule-auchan',
			pattern: 'AUCHAN',
			targetCategory: 'Alimentation',
			type: 'expense',
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;AUCHAN COURSES;-42,10;Autre');

		expect(db.state.categories[0].name).toBe('Alimentation');
		expect(db.state.transactions[0].type).toBe('expense');
	});

	it('applies a rule that recategorizes a transaction', async () => {
		expect.assertions(2);

		db.state.rules.push({
			id: 'rule-revolut',
			pattern: 'REVOLUT',
			targetCategory: 'Virement interne',
			type: 'expense',
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;REVOLUT;-30;Autre');

		expect(db.state.categories[0].name).toBe('Virement interne');
		expect(db.state.transactions[0].type).toBe('expense');
	});

	it('applies a user rule as manualCategory during import', async () => {
		expect.assertions(2);

		db.state.rules.push({
			id: 'category-rule-patreon',
			pattern: 'patreon',
			targetCategory: 'Abonnements',
			type: null,
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;PATREON EUROPE;-8,00;Autre');

		expect(db.state.transactions[0].manualCategory).toBe('Abonnements');
		expect(db.state.transactions[0].userId).toBe(testUser.id);
	});

	it('creates an enriched ImportBatch on import', async () => {
		expect.assertions(5);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`);

		expect(db.state.batches).toHaveLength(1);
		expect(db.state.batches[0]).toMatchObject({
			fileName: 'export.csv',
			profile: 'banque-populaire',
			rowCount: 1,
			importedRows: 1
		});
		expect(db.state.batches[0].periodStart).toBeInstanceOf(Date);
		expect(db.state.transactions[0].importBatchId).toBe(db.state.batches[0].id);
		expect(db.prisma.importBatch.update).toHaveBeenCalled();
	});

	it('ignores duplicates on a second import of the same CSV', async () => {
		expect.assertions(4);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`);
		const second = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(db.state.transactions).toHaveLength(1);
		expect(second.importResult.importedRows).toBe(0);
		expect(second.importResult.duplicateRows).toBe(1);
		expect(second.importResult.totalDebitCents).toBe(0);
	});

	it('ne persiste pas les lignes invalides', async () => {
		expect.assertions(6);

		const invalidRow =
			'24/06/2026;VIDE;VIDE;REFBAD;;Carte bancaire;Autre;;;;24/06/2026;24/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${invalidRow}`
		);
		const importResult = getImportResult(result);

		expect(importResult.totalRows).toBe(2);
		expect(importResult.importedRows).toBe(1);
		expect(importResult.invalidRows).toBe(1);
		expect(importResult.invalidRowDetails[0]).toMatchObject({
			lineNumber: 3,
			reason: 'débit et crédit vides',
			field: 'Debit/Credit',
			profile: 'banque-populaire'
		});
		expect(importResult.invalidRowDetails[0].preview).not.toContain('REFBAD');
		expect(db.state.transactions).toHaveLength(1);
	});

	it('limits the returned invalid line list to 20', async () => {
		expect.assertions(3);

		const invalidRows = Array.from(
			{ length: 21 },
			(_, index) =>
				`24/06/2026;VIDE${index};VIDE${index};REFBAD${index};;Carte bancaire;Autre;;;;24/06/2026;24/06/2026;0`
		).join('\n');
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${invalidRows}`
		);
		const importResult = getImportResult(result);

		expect(importResult.invalidRows).toBe(21);
		expect(importResult.invalidRowDetails).toHaveLength(20);
		expect(importResult.hiddenInvalidRowsCount).toBe(1);
	});

	it('anonymizes previews and does not return raw banking data', async () => {
		expect.assertions(5);

		const sensitiveInvalidRow =
			'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;;;23/06/2026;23/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${sensitiveInvalidRow}`
		);
		const preview = getImportResult(result).invalidRowDetails[0].preview;

		expect(preview).toContain('AUCHAN');
		expect(preview).toContain('CB****');
		expect(preview).not.toContain('AUCHAN 0065 SC 78MAUREPAS');
		expect(preview).not.toContain('80FDBFG');
		expect(preview).not.toContain('2593');
	});

	it('truncates each preview cell to 18 characters', async () => {
		expect.assertions(3);

		const longPlainTextRow =
			'23/06/2026;VIDE;Restaurant du coin bien sympa sans chiffres;REFBAD;;Carte bancaire;Autre;;;;23/06/2026;23/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${longPlainTextRow}`
		);
		const preview = getImportResult(result).invalidRowDetails[0].preview;
		const cells = preview.split(' | ');

		expect(cells.some((cell) => cell === 'Restaurant du coi…')).toBe(true);
		expect(cells.every((cell) => cell.length <= 18)).toBe(true);
		expect(preview).not.toContain('Restaurant du coin bien sympa sans chiffres');
	});

	it('does not log raw banking data during diagnostics', async () => {
		expect.assertions(2);

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const sensitiveInvalidRow =
			'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;;;23/06/2026;23/06/2026;0';

		await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${sensitiveInvalidRow}`
		);

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it('no longer references the /demo route', () => {
		expect.assertions(1);

		expect(existsSync(resolve(root, 'src/routes/demo/+page.svelte'))).toBe(false);
	});

	it('does not break the generic import', async () => {
		expect.assertions(6);

		const result = await runImportWithFile(
			'date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus\n2026-06-02;Courses;-42,10;Alimentation'
		);

		expect(result.importResult.profile).toBe('generic');
		expect(result.importResult.importedRows).toBe(2);
		expect(result.importResult.totalCreditCents).toBe(250_050);
		expect(result.importResult.totalDebitCents).toBe(4_210);
		expect(db.state.transactions[0]).toMatchObject({
			amountCents: 250_050,
			type: 'income',
			source: 'csv'
		});
		expect(db.state.transactions[1]).toMatchObject({
			amountCents: 4_210,
			type: 'expense',
			source: 'csv'
		});
	});

	it('imports a Revolut CSV and keeps the detected profile', async () => {
		expect.assertions(10);

		const result = await runImportWithFile(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,EUR,TERMINÉ,114.00`
		);
		const metadata = JSON.parse(db.state.transactions[0].metadataJson ?? '{}') as {
			revolutFeeCents?: number;
			revolutCurrency?: string;
			revolutState?: string;
			csvFields?: Record<string, string>;
		};

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalDebitCents).toBe(780);
		expect(db.state.batches[0].source).toBe('revolut');
		expect(db.state.transactions[0]).toMatchObject({
			label: 'Patreon',
			amountCents: 780,
			type: 'expense',
			source: 'revolut'
		});
		expect(metadata.revolutFeeCents).toBe(0);
		expect(metadata.revolutCurrency).toBe('EUR');
		expect(metadata.revolutState).toBe('TERMINÉ');
		expect(metadata.csvFields?.Frais).toBeUndefined();
		expect(metadata.csvFields?.Description).toBeUndefined();
	});

	it('importe un XLSX Revolut en colonnes', async () => {
		expect.assertions(6);

		const result = await runImportWithXlsxFile([
			REVOLUT_HEADER.split(','),
			[
				'Paiement par carte',
				'Valeur actuelle',
				'2026-05-01 02:52:44',
				'2026-05-01 05:37:37',
				'Patreon',
				'-7.80',
				'0.00',
				'EUR',
				'TERMINÉ',
				'114.00'
			]
		]);

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalDebitCents).toBe(780);
		expect(db.state.batches[0].fileName).toBe('export.xlsx');
		expect(db.state.transactions[0]).toMatchObject({
			label: 'Patreon',
			amountCents: 780,
			type: 'expense',
			source: 'revolut'
		});
		expect(db.state.transactions[0].metadataJson).toContain('TERMINÉ');
	});

	it('imports an XLSX Revolut CSV disguised with repaired mojibake', async () => {
		expect.assertions(5);

		const result = await runImportWithXlsxFile(
			[
				['Type,Produit,Date de dÃ©but,Date de fin,Description,Montant,Frais,Devise,Ã‰tat,Solde'],
				[
					'Ajout de fonds,Valeur actuelle,2026-05-04 18:52:52,2026-05-04 18:53:06,Recharge via *2593,60.00,0.00,EUR,TERMINÃ‰,73.98'
				]
			],
			'revolut.xlsx'
		);
		const metadata = JSON.parse(db.state.transactions[0].metadataJson ?? '{}') as {
			revolutState?: string;
		};

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalCreditCents).toBe(6_000);
		expect(db.state.transactions[0].type).toBe('income');
		expect(metadata.revolutState).toBe('TERMINÉ');
	});

	it('imports a valid maison line and writes natureManual to DB', async () => {
		expect.assertions(4);

		const result = await runImportWithFile(
			`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
		);

		expect(result.importResult.profile).toBe('maison');
		expect(result.importResult.importedRows).toBe(1);
		expect(db.state.transactions[0].amountCents).toBe(4_210);
		expect(db.state.transactions[0].natureManual).toBe('spending');
	});

	it('links a newly-created bucket to a valid, owned, linkable net worth account', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		await runImport(formData);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBe('nwa-1');
	});

	it('regression F7: an existing revolut bucket does not block linking on a first-ever banque_populaire import (distinct sources, distinct buckets)', async () => {
		expect.assertions(4);

		db.state.accounts.push({
			id: 'account-revolut',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'revolut',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(2);
		const banquePopulaireAccount = db.state.accounts.find(
			(account) => account.source === 'banque_populaire'
		);
		expect(banquePopulaireAccount?.netWorthAccountId).toBe('nwa-1');
		expect(
			db.state.accounts.find((account) => account.source === 'revolut')?.netWorthAccountId
		).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('applied');
	});

	it('reports netWorthLinkStatus "ignored" when a destination is selected but a bucket for this exact profile already exists', async () => {
		expect.assertions(2);

		db.state.accounts.push({
			id: 'account-bp',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'banque_populaire',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(
			db.state.accounts.find((account) => account.source === 'banque_populaire')?.netWorthAccountId
		).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it('rejects a net worth account id belonging to another user, without any write', async () => {
		expect.assertions(4);

		db.state.netWorthAccounts.push({
			id: 'nwa-foreign',
			userId: 'someone-else',
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-foreign');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Le compte de patrimoine sélectionné est invalide.');
		expect(db.state.accounts).toHaveLength(0);
		expect(db.state.transactions).toHaveLength(0);
	});

	it('rejects a nonexistent net worth account id, without any write', async () => {
		expect.assertions(3);

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-does-not-exist');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(db.state.accounts).toHaveLength(0);
		expect(db.state.transactions).toHaveLength(0);
	});

	it('rejects a net worth account of a non-linkable type (real_estate/other)', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push({
			id: 'nwa-house',
			userId: testUser.id,
			name: 'Maison',
			type: 'real_estate',
			balanceCents: 100_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-house');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(db.state.accounts).toHaveLength(0);
	});

	it('does not change an already-linked bucket link on re-import, even with a different id submitted', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push(
			{
				id: 'nwa-1',
				userId: testUser.id,
				name: 'Compte courant',
				type: 'checking',
				balanceCents: 10_000,
				deletedAt: null,
				createdAt: new Date()
			},
			{
				id: 'nwa-2',
				userId: testUser.id,
				name: 'Livret',
				type: 'savings',
				balanceCents: 5_000,
				deletedAt: null,
				createdAt: new Date()
			}
		);
		db.state.accounts.push({
			id: 'account-existing',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'banque_populaire',
			currency: 'EUR',
			netWorthAccountId: 'nwa-1'
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-2');
		await runImport(formData);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBe('nwa-1');
	});

	it('keeps working exactly as before when netWorthAccountId is absent (backward compat)', async () => {
		expect.assertions(3);

		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(result.importResult.importedRows).toBe(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(result.importResult.netWorthLinkStatus).toBeNull();
	});

	it("maison and generic profiles share the same 'csv' bucket: a generic-created csv bucket makes a first maison import report netWorthLinkStatus 'ignored'", async () => {
		expect.assertions(3);

		db.state.accounts.push({
			id: 'account-csv-generic',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File(
				[`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`],
				'export.csv',
				{ type: 'text/csv' }
			)
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it("maison and generic profiles share the same 'csv' bucket: a maison-created csv bucket makes a first generic import report netWorthLinkStatus 'ignored'", async () => {
		expect.assertions(3);

		db.state.accounts.push({
			id: 'account-csv-maison',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File(['date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus'], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it('universal deduplication: a maison line identical to a transaction already imported via another profile is ignored', async () => {
		expect.assertions(3);

		// Transaction already in the database, previously imported via the banque-populaire profile
		// (or any other profile), with the same date|amountCents|label fingerprint as the maison profile.
		const existingFingerprint = buildMaisonDeduplicationKey({
			date: '2026-06-01',
			amountCents: 4_210,
			label: 'Courses Auchan'
		});
		db.state.transactions.push({
			id: 'transaction-existing',
			accountId: 'account-existing',
			categoryId: 'category-existing',
			importBatchId: 'batch-existing',
			userId: testUser.id,
			date: new Date('2026-06-01T00:00:00.000Z'),
			label: 'Courses Auchan',
			amountCents: 4_210,
			type: 'expense',
			source: 'banque_populaire',
			notes: null,
			manualCategory: null,
			natureManual: null,
			dedupeKey: existingFingerprint,
			dedupeKeyHash: computeDedupeKeyHash(existingFingerprint),
			metadataJson: null
		});

		const result = await runImportWithFile(
			`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
		);

		expect(db.state.transactions).toHaveLength(1);
		expect(result.importResult.importedRows).toBe(0);
		expect(result.importResult.duplicateRows).toBe(1);
	});
});

async function runImportWithFile(content: string) {
	const formData = new FormData();
	formData.set('csvFile', new File([content], 'export.csv', { type: 'text/csv' }));
	return runImport(formData);
}

async function runImportWithXlsxFile(rows: string[][], fileName = 'export.xlsx') {
	const formData = new FormData();
	const bytes = buildXlsx(rows);
	const arrayBuffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(arrayBuffer).set(bytes);
	formData.set(
		'csvFile',
		new File([arrayBuffer], fileName, {
			type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		})
	);
	return runImport(formData);
}

async function runImport(formData: FormData) {
	const action = actions.default as (event: {
		locals: { user: typeof testUser };
		request: Request;
	}) => Promise<unknown>;
	return (await action({
		locals: { user: testUser },
		request: new Request('http://localhost/import', {
			method: 'POST',
			body: formData
		})
	})) as {
		status?: number;
		data: {
			error: string;
			importResult?: {
				fileName?: string;
				profile?: string;
				totalRows: number;
				importedRows: number;
				duplicateRows: number;
				invalidRows: number;
				totalDebitCents: number;
				totalCreditCents: number;
				invalidRowDetails: Array<{
					lineNumber: number;
					reason: string;
					field: string;
					profile: string;
					preview: string;
				}>;
				hiddenInvalidRowsCount: number;
				netWorthLinkStatus?: 'applied' | 'ignored' | null;
			};
		};
		importResult: {
			fileName?: string;
			profile?: string;
			totalRows: number;
			importedRows: number;
			duplicateRows: number;
			invalidRows: number;
			totalDebitCents: number;
			totalCreditCents: number;
			invalidRowDetails: Array<{
				lineNumber: number;
				reason: string;
				field: string;
				profile: string;
				preview: string;
			}>;
			hiddenInvalidRowsCount: number;
			netWorthLinkStatus?: 'applied' | 'ignored' | null;
		};
	};
}

function getImportResult(result: Awaited<ReturnType<typeof runImport>>) {
	return result.importResult ?? result.data.importResult;
}

function buildXlsx(rows: string[][]): Uint8Array {
	const files = new Map<string, string>([
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
				'</Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
				'</Relationships>'
		],
		[
			'xl/workbook.xml',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
				'</workbook>'
		],
		[
			'xl/_rels/workbook.xml.rels',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
				'</Relationships>'
		],
		['xl/worksheets/sheet1.xml', buildWorksheetXml(rows)]
	]);

	return zipStored(files);
}

function buildWorksheetXml(rows: string[][]): string {
	const sheetData = rows
		.map((row, rowIndex) => {
			const rowNumber = rowIndex + 1;
			const cells = row
				.map((value, columnIndex) => {
					const ref = `${columnName(columnIndex)}${rowNumber}`;
					return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
				})
				.join('');
			return `<row r="${rowNumber}">${cells}</row>`;
		})
		.join('');

	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		`<sheetData>${sheetData}</sheetData>` +
		'</worksheet>'
	);
}

function zipStored(files: Map<string, string>): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const centralDirectory: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of files) {
		const nameBytes = encoder.encode(name);
		const contentBytes = encoder.encode(content);
		const crc = crc32(contentBytes);
		const localHeader = concatBytes(
			u32(0x04034b50),
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(contentBytes.length),
			u32(contentBytes.length),
			u16(nameBytes.length),
			u16(0),
			nameBytes
		);
		chunks.push(localHeader, contentBytes);
		centralDirectory.push(
			concatBytes(
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(crc),
				u32(contentBytes.length),
				u32(contentBytes.length),
				u16(nameBytes.length),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				nameBytes
			)
		);
		offset += localHeader.length + contentBytes.length;
	}

	const centralOffset = offset;
	const centralBytes = concatBytes(...centralDirectory);
	const end = concatBytes(
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(files.size),
		u16(files.size),
		u32(centralBytes.length),
		u32(centralOffset),
		u16(0)
	);

	return concatBytes(...chunks, centralBytes, end);
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function u16(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff
	]);
}

function columnName(index: number): string {
	let name = '';
	let current = index + 1;
	while (current > 0) {
		const remainder = (current - 1) % 26;
		name = String.fromCharCode(65 + remainder) + name;
		current = Math.floor((current - 1) / 26);
	}
	return name;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
