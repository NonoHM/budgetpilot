// Script ponctuel à lancer UNE FOIS après déploiement de la migration "add_income_nature".
// Les comptes déjà seedés (avant cette migration) ont un CategoryNatureMapping
// categoryName="Revenus" → nature="uncategorized" (ancien fallback par défaut des revenus),
// que le seeding one-shot ne réécrira jamais. Ce script bascule ces lignes vers "income",
// le nouveau fallback des transactions de type "income". Update global scope par nom de
// catégorie exact (pas de userId client, pas de lecture/exposition de données utilisateur).
//
// Usage : node scripts/migrate-revenus-nature.mjs

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import prismaClientPkg from '@prisma/client';

const { PrismaClient } = prismaClientPkg;

const adapter = new PrismaBetterSqlite3({
	url: process.env.DATABASE_URL ?? 'file:./dev.db'
});
const prisma = new PrismaClient({ adapter });

const result = await prisma.categoryNatureMapping.updateMany({
	where: { categoryName: 'Revenus', nature: 'uncategorized' },
	data: { nature: 'income' }
});

console.log(`Mappings "Revenus" migrés vers la nature "income" : ${result.count}`);

await prisma.$disconnect();
