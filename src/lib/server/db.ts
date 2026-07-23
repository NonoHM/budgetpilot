import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import prismaClientPkg from '@prisma/client';

type PrismaClient = import('@prisma/client').PrismaClient;

const { PrismaClient } = prismaClientPkg;

const globalForPrisma = globalThis as unknown as {
	prisma?: PrismaClient;
};

// The dev.db fallback is for local development only: a production run without DATABASE_URL
// set would otherwise silently write to a fresh/empty file instead of the real /data volume.
if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
	throw new Error('DATABASE_URL is required in production (set it in your environment)');
}

const adapter = new PrismaBetterSqlite3({
	url: process.env.DATABASE_URL ?? 'file:./dev.db'
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
	globalForPrisma.prisma = prisma;
}
