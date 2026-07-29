// Seed un compte de test local + données d'exemple pour vérification visuelle.
// Requiert le serveur dev démarré (npm run dev) : la création/connexion du compte
// passe par les vraies routes /register et /login (pas de réimplémentation du
// hachage de mot de passe ou du seed des catégories par défaut).
//
// Credentials et usage : voir docs/local/dev-credentials.md (non versionné).
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import prismaClientPkg from '@prisma/client';
// Imported from the app rather than restated here, so seeded rows carry the same keys the app
// writes (Node runs the TypeScript source directly, same as scripts/normalize-names.mjs).
import { computeNameKey } from '../src/lib/server/naming/nameKey.ts';

const { PrismaClient } = prismaClientPkg;

const BASE = process.env.SEED_DEV_BASE_URL ?? 'http://localhost:5173';
const EMAIL = 'dev@budgetpilot.local';
const PASSWORD = 'DevBudgetPilot123!';

async function submitForm(path, fields) {
	const body = new URLSearchParams(fields);
	const res = await fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: BASE
		},
		body,
		redirect: 'manual'
	});
	const cookie = res.headers.get('set-cookie');
	return { status: res.status, cookie };
}

async function ensureTestAccount() {
	const loginRes = await submitForm('/login', { email: EMAIL, password: PASSWORD });
	if (loginRes.cookie) {
		console.log('Compte de test existant, connexion OK.');
		return;
	}

	const registerRes = await submitForm('/register', {
		email: EMAIL,
		password: PASSWORD,
		bootstrapToken: process.env.BOOTSTRAP_TOKEN ?? ''
	});
	if (!registerRes.cookie && registerRes.status !== 303) {
		throw new Error(
			`Échec register/login (status ${registerRes.status}). Le serveur dev tourne-t-il sur ${BASE} ?`
		);
	}
	console.log('Compte de test créé.');
}

try {
	await ensureTestAccount();
} catch (err) {
	console.error(err.message);
	console.error(`Lance "npm run dev" (ou définis SEED_DEV_BASE_URL) puis relance ce script.`);
	process.exit(1);
}

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });

const account = await prisma.account.upsert({
	where: { userId_name_source: { userId: user.id, name: 'Compte principal', source: 'manual' } },
	update: {},
	create: {
		userId: user.id,
		name: 'Compte principal',
		nameKey: computeNameKey('Compte principal')
	}
});

async function ensureCategory(name) {
	return prisma.category.upsert({
		where: { userId_name: { userId: user.id, name } },
		update: {},
		create: { userId: user.id, name, nameKey: computeNameKey(name) }
	});
}

// Nom brut du sentinel système (cf. UNCLASSIFIED_CATEGORY dans src/lib/domain/categories.ts,
// non importable ici — script Node exécuté hors Vite) : le nom réel en DB est "uncategorized",
// jamais le libellé affiché "Non catégorisé" (qui créerait une 2e catégorie à chaque reseed et
// casserait la résolution de nature "à classer", cf. isUncategorizedByCategory).
const catUncat = await ensureCategory('uncategorized');
const catFood = await ensureCategory('Alimentation');
const catTransport = await ensureCategory('Transport');
const catInvest = await ensureCategory('Investissement');
await ensureCategory('Abonnements');
const catOther = await ensureCategory('Autres');

// Idempotent : on repart de zéro sur les règles/transactions à chaque run.
await prisma.categoryRule.deleteMany({ where: { userId: user.id } });
await prisma.transaction.deleteMany({ where: { userId: user.id } });

await prisma.categoryRule.createMany({
	data: [
		{
			userId: user.id,
			name: 'Trade Republic DE Berlin',
			matchText: 'Trade Republic DE Berlin',
			targetCategory: catInvest.name,
			targetNature: 'investment',
			isRegex: false,
			enabled: true
		},
		{
			userId: user.id,
			name: 'INDIGO Parkings',
			matchText: 'INDIGO[0-9]{10}VERSA',
			targetCategory: catTransport.name,
			targetNature: null,
			isRegex: true,
			enabled: true
		},
		{
			userId: user.id,
			name: 'Revolut 8761 FR Paris',
			matchText: 'Revolut 8761 FR Paris',
			targetCategory: catOther.name,
			targetNature: null,
			isRegex: false,
			enabled: true
		},
		{
			userId: user.id,
			name: 'VIR SEPA CB',
			matchText: 'VIR SEPA CB',
			targetCategory: catFood.name,
			targetNature: null,
			isRegex: false,
			enabled: true
		}
	]
});

const labels = [
	'VIR SEPA CB****4821',
	'CB INDIGO00780216',
	'GOOGLE GOOGLE PIE IE',
	'REVOLUT 8761 FR PARIS',
	'TRADE REPUBLIC DE BERLIN',
	'AMAZON EU SARL',
	'SNCF CONNECT PARIS',
	'CARREFOUR MARKET',
	'NETFLIX.COM',
	'FREE MOBILE',
	'BOULANGERIE DU COIN',
	'TOTALENERGIES STATION'
];

let day = 1;
for (const label of labels) {
	await prisma.transaction.create({
		data: {
			userId: user.id,
			accountId: account.id,
			categoryId: catUncat.id,
			date: new Date(new Date().getFullYear(), new Date().getMonth(), day++),
			label,
			amountCents: -Math.round(Math.random() * 8000 + 500),
			type: 'expense',
			source: 'manual'
		}
	});
}

console.log(
	`Seed terminé pour ${EMAIL} : compte, catégories, règles, ${labels.length} transactions.`
);
await prisma.$disconnect();
