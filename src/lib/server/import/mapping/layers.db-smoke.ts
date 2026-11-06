import { env } from '$env/dynamic/private';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildBackupExport } from '$lib/server/backup/export';
import { restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import { fingerprintFor } from './fingerprint';
import { storedLayers, UNKNOWN_LAYERS } from './layers';
import type { ColumnMappingInput } from './model';
import { saveColumnMapping } from './store';

/**
 * #1207 C2b: the layer stored with each kept role, against a real engine, read back through
 * `storedLayers`, the one reader, never the raw column. The two writers are the save
 * (`saveColumnMapping`) and the backup restore; a writer older than 1.4 is modelled by an update
 * that moves a role column and leaves the layers, which is what its upsert does.
 */

env.RATE_LIMIT_HASH_SECRET ??= 'c3'.repeat(32);

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error('DATABASE_URL points at dev.db. Point it at a throwaway database instead.');
}

const HEADERS = ['date', 'libelle', 'montant', 'categorie'];
const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'date',
	labelColumn: 'libelle',
	amountColumn: 'montant',
	categoryColumn: 'categorie',
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 4
};
const LAYERS = {
	dateLayer: 'rule',
	labelLayer: 'member',
	amountLayer: 'rule',
	categoryLayer: 'member'
} as const;

const createdUserIds: string[] = [];
afterAll(async () => {
	if (createdUserIds.length > 0)
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

async function member(): Promise<string> {
	const { id } = await prisma.user.create({
		data: {
			email: `layers-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(id);
	return id;
}

async function onlyMapping(userId: string) {
	const rows = await prisma.columnMapping.findMany({ where: { userId } });
	expect(rows).toHaveLength(1);
	return rows[0];
}

describe('the layers a save writes', () => {
	// Separates « the save wrote the layers it was given, with their key » from « nothing written ».
	it('stores each layer and reads it back through the one reader', async () => {
		const userId = await member();
		const saved = await saveColumnMapping(
			userId,
			fingerprintFor(HEADERS, 'name'),
			MAPPING,
			LAYERS,
			null
		);
		expect(saved.ok).toBe(true);
		expect(storedLayers(await onlyMapping(userId))).toEqual(LAYERS);
	});

	// Separates a layer still describing its column from one a pre-1.4 writer left behind (F4).
	it('reads every layer unknown once a writer that ignores them moves a role column', async () => {
		const userId = await member();
		await saveColumnMapping(userId, fingerprintFor(HEADERS, 'name'), MAPPING, LAYERS, null);
		const row = await onlyMapping(userId);
		await prisma.columnMapping.update({
			where: { id: row.id },
			data: { labelColumn: 'categorie', categoryColumn: 'libelle' }
		});
		expect(storedLayers(await onlyMapping(userId))).toEqual(UNKNOWN_LAYERS);
	});
});

describe('the layers a backup carries', () => {
	// Separates a faithful round trip from one that drops the layers.
	it('brings each layer back after an export and a restore', async () => {
		const userId = await member();
		await saveColumnMapping(userId, fingerprintFor(HEADERS, 'name'), MAPPING, LAYERS, null);
		const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
		await restoreBackup(userId, backupExportSchema.parse(file));
		expect(storedLayers(await onlyMapping(userId))).toEqual(LAYERS);
	});

	// Separates « the export writes a layer through its one reader » from « it writes the raw column »:
	// a layer a pre-1.4 writer left behind goes out unknown, never as a fact (break D2).
	it('exports a layer whose key no longer matches as unknown', async () => {
		const userId = await member();
		await saveColumnMapping(userId, fingerprintFor(HEADERS, 'name'), MAPPING, LAYERS, null);
		const row = await onlyMapping(userId);
		await prisma.columnMapping.update({
			where: { id: row.id },
			data: { labelColumn: 'categorie', categoryColumn: 'libelle' }
		});
		const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
		const { dateLayer, labelLayer, amountLayer, categoryLayer } = file.columnMappings[0];
		expect({ dateLayer, labelLayer, amountLayer, categoryLayer }).toEqual(UNKNOWN_LAYERS);
	});

	// Separates « the restore keeps what the save path can produce » from « it trusts the file »:
	// `file` and `model` on a saved role, and `rule` on the category, cannot come from a save.
	it('restores a layer no save could have produced as unknown', async () => {
		const userId = await member();
		await saveColumnMapping(userId, fingerprintFor(HEADERS, 'name'), MAPPING, LAYERS, null);
		const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
		Object.assign(file.columnMappings[0], {
			dateLayer: 'file',
			labelLayer: 'model',
			amountLayer: 'member',
			categoryLayer: 'rule'
		});
		await restoreBackup(userId, backupExportSchema.parse(file));
		expect(storedLayers(await onlyMapping(userId))).toEqual({
			...UNKNOWN_LAYERS,
			amountLayer: 'member'
		});
	});
});

describe('the recap reads the layers of the correspondance its batch was read through', () => {
	// Separates « the recap route hands the screen each stored layer » from « it drops them », and
	// the batch is reached through `{ id, userId }`, so another member's batch is a 404.
	it('returns the stored layers by role, and refuses another member batch', async () => {
		const { load } = await import('../../../../routes/imports/[batchId]/columns/+page.server');
		const userId = await member();
		const other = await member();
		await saveColumnMapping(userId, fingerprintFor(HEADERS, 'name'), MAPPING, LAYERS, null);
		const mapping = await onlyMapping(userId);
		const batch = await prisma.importBatch.create({
			data: { userId, rowCount: 0, fileName: 'releve.csv', columnMappingId: mapping.id },
			select: { id: true }
		});
		const call = (id: string) =>
			load({
				locals: { user: { id, email: 'x@example.test', role: 'USER' } },
				params: { batchId: batch.id }
			} as never);

		const data = (await call(userId)) as { layers?: unknown };
		expect(data.layers).toEqual({
			date: 'rule',
			label: 'member',
			amount: 'rule',
			category: 'member'
		});
		await expect(call(other)).rejects.toMatchObject({ status: 404 });
	});
});
