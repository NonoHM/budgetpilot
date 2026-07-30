import { createPrismaClient } from './database/client';

type PrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
	prisma?: PrismaClient;
};

// The dev.db fallback is for local development only: a production run without DATABASE_URL
// set would otherwise silently write to a fresh/empty file instead of the real /data volume.
if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
	throw new Error('DATABASE_URL is required in production (set it in your environment)');
}

// Which engine, and how it is reached, lives in database/client.ts — shared with the
// maintenance scripts so there is one answer to "how does this app connect".
export const prisma = globalForPrisma.prisma ?? createPrismaClient(process.env);

if (process.env.NODE_ENV !== 'production') {
	globalForPrisma.prisma = prisma;
}
