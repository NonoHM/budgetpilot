import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { applyCategoryRules } from '$lib/server/categorization/rules';
import { compileRegex } from '$lib/server/matching/regex';
import {
	ensureDefaultRulesSeeded,
	restoreMissingDefaultRules
} from '$lib/server/categorization/defaultRules';
import { buildBackupExport } from './export';
import { BackupImportError, restoreBackup } from './import';
import { backupExportSchema, type BackupExport } from './schema';

/**
 * A category rule through a backup and back, against a real engine (#1173).
 *
 * Every assertion is about what the restored rules DO to a transaction, through the production
 * `applyCategoryRules`, rather than about the columns alone: a rule that comes back with the
 * right text and the wrong mode, or the right rules in the wrong order, looks identical in the
 * rule list and classifies differently on every later import.
 *
 * See vitest.db.config.ts for how to run this.
 */

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a ' +
			'server engine) to a throwaway database explicitly. It refuses to fall back to the ' +
			'default local SQLite file.'
	);
}
if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const createdUserIds: string[] = [];

async function freshUser(categories: string[]): Promise<string> {
	const user = await prisma.user.create({
		data: {
			email: `rule-round-trip-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	createdUserIds.push(user.id);
	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', currency: 'EUR', exponent: 2, source: 'csv' },
		select: { id: true }
	});
	const unclassified = await prisma.category.create({
		data: {
			userId: user.id,
			name: UNCLASSIFIED_CATEGORY,
			nameKey: computeNameKey(UNCLASSIFIED_CATEGORY)
		},
		select: { id: true }
	});
	for (const name of categories) {
		await prisma.category.create({
			data: { userId: user.id, name, nameKey: computeNameKey(name) }
		});
	}
	await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: user.id,
			accountId: account.id,
			categoryId: unclassified.id,
			date: new Date(Date.UTC(2026, 5, 15)),
			label: 'SUPER MARKET AUCHAN',
			amountCents: -4_200,
			type: 'expense',
			source: 'manual'
		}
	});
	return user.id;
}

function rule(
	userId: string,
	fields: { name: string; matchText: string; targetCategory: string; isRegex?: boolean }
) {
	return { userId, enabled: true, isRegex: false, ...fields };
}

/** Round trips the user's data through the serialised file, as a download and upload would. */
async function roundTrip(userId: string): Promise<void> {
	const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
	await restoreBackup(userId, backupExportSchema.parse(file));
}

/** Which category the production rule pass gives the one seeded transaction. */
async function classify(userId: string): Promise<string | null> {
	await prisma.transaction.updateMany({ where: { userId }, data: { manualCategory: null } });
	await applyCategoryRules(userId);
	const row = await prisma.transaction.findFirstOrThrow({
		where: { userId },
		select: { manualCategory: true }
	});
	return row.manualCategory;
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET ??= 'c7'.repeat(32);
});

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

describe('a category rule through a backup', () => {
	it('keeps a regex rule a regex, so it still classifies what it matched', async () => {
		// SEPARATES « isRegex is carried » FROM « it defaults to false on restore », where the
		// pattern is searched for as literal text and matches nothing.
		const userId = await freshUser(['Courses']);
		await prisma.categoryRule.create({
			data: rule(userId, {
				name: 'Supermarchés',
				matchText: 'carrefour|auchan',
				targetCategory: 'Courses',
				isRegex: true
			})
		});
		expect(await classify(userId), 'the rule must match before the backup').toBe('Courses');

		await roundTrip(userId);

		expect(await classify(userId)).toBe('Courses');
	});

	it('keeps the suggested rules linked to their pack: regex mode kept, nothing re-seeded', async () => {
		// SEPARATES « defaultRuleKey and isRegex are carried » FROM « the pack rules come back as
		// custom literal rules », after which « Restore suggested rules » duplicates every one.
		const userId = await freshUser([]);
		await ensureDefaultRulesSeeded(userId);
		const before = {
			total: await prisma.categoryRule.count({ where: { userId } }),
			regex: await prisma.categoryRule.count({ where: { userId, isRegex: true } }),
			linked: await prisma.categoryRule.count({ where: { userId, defaultRuleKey: { not: null } } })
		};
		// The starting figure, so a catalog without regex entries cannot pass this vacuously.
		expect(before.regex).toBeGreaterThan(0);
		expect(before.linked).toBe(before.total);

		await roundTrip(userId);

		expect({
			total: await prisma.categoryRule.count({ where: { userId } }),
			regex: await prisma.categoryRule.count({ where: { userId, isRegex: true } }),
			linked: await prisma.categoryRule.count({ where: { userId, defaultRuleKey: { not: null } } })
		}).toEqual(before);
		expect(await restoreMissingDefaultRules(userId)).toBe(0);
	});

	it('keeps priority when the rule that wins is not the first row the engine returns', async () => {
		// SEPARATES « the restore keeps the matcher's order (createdAt, then id) » FROM « it keeps
		// whatever order the export read the rows in ». Inserted out of priority order on purpose:
		// PostgreSQL produces the same state on its own, because an UPDATE moves the row to the end
		// of the heap, so an edited rule is read last by a query with no ORDER BY.
		const userId = await freshUser(['Marché', 'Courses']);
		await prisma.categoryRule.create({
			data: {
				...rule(userId, { name: 'Super', matchText: 'super', targetCategory: 'Courses' }),
				createdAt: new Date(Date.UTC(2026, 1, 2))
			}
		});
		await prisma.categoryRule.create({
			data: {
				...rule(userId, { name: 'Market', matchText: 'market', targetCategory: 'Marché' }),
				createdAt: new Date(Date.UTC(2026, 1, 1))
			}
		});
		expect(await classify(userId), 'the earlier rule must win before the backup').toBe('Marché');

		await roundTrip(userId);

		expect(await classify(userId)).toBe('Marché');
		// The timestamps themselves, which the priority above does not need once the export is ordered:
		// a backup is a copy, and /rules shows rules by this column.
		const stamps = await prisma.categoryRule.findMany({
			where: { userId },
			select: { name: true, createdAt: true }
		});
		expect(
			Object.fromEntries(stamps.map((row) => [row.name, row.createdAt.toISOString()]))
		).toEqual({
			Super: '2026-02-02T00:00:00.000Z',
			Market: '2026-02-01T00:00:00.000Z'
		});
	});

	it('keeps priority between rules sharing a timestamp, which a restore before this fix leaves', async () => {
		// SEPARATES « the export is ordered by id within one createdAt » FROM « by read order ».
		// Equal timestamps are what every restore before #1173 wrote, so this is a real state.
		const userId = await freshUser(['Marché', 'Courses']);
		const at = new Date(Date.UTC(2026, 1, 1));
		await prisma.categoryRule.create({
			data: {
				...rule(userId, { name: 'Super', matchText: 'super', targetCategory: 'Courses' }),
				id: 'rule-b-second-by-id',
				createdAt: at
			}
		});
		await prisma.categoryRule.create({
			data: {
				...rule(userId, { name: 'Market', matchText: 'market', targetCategory: 'Marché' }),
				id: 'rule-a-first-by-id',
				createdAt: at
			}
		});
		expect(await classify(userId), 'the lower id must win before the backup').toBe('Marché');

		await roundTrip(userId);

		expect(await classify(userId)).toBe('Marché');
	});

	it('restores a file written before these fields existed as a literal, custom rule', async () => {
		// The compatibility contract. Green before the fix too, by construction: it guards the
		// DEFAULTS the fix introduces, which a required field would break by refusing old files.
		const userId = await freshUser(['Courses']);
		await prisma.categoryRule.create({
			data: rule(userId, { name: 'Auchan', matchText: 'auchan', targetCategory: 'Courses' })
		});
		const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
		for (const row of file.categoryRules) {
			delete row.isRegex;
			delete row.defaultRuleKey;
			delete row.createdAt;
		}

		await restoreBackup(userId, backupExportSchema.parse(file));

		const restored = await prisma.categoryRule.findFirstOrThrow({
			where: { userId },
			select: { isRegex: true, defaultRuleKey: true }
		});
		expect(restored).toEqual({ isRegex: false, defaultRuleKey: null });
		expect(await classify(userId)).toBe('Courses');
	});

	it('refuses a regex rule whose compiled program exceeds the cost ceiling, before writing anything', async () => {
		// SEPARATES « the restore applies F4's program-size ceiling » FROM « a hand-edited file plants
		// a pattern past it that no form would accept ». `a{1000}` is seven
		// characters, under every length cap, and compiles to about a thousand instructions.
		const userId = await freshUser(['Courses']);
		await prisma.categoryRule.create({
			data: rule(userId, { name: 'Auchan', matchText: 'auchan', targetCategory: 'Courses' })
		});
		const file = JSON.parse(JSON.stringify(await buildBackupExport(userId)));
		file.categoryRules.push({
			...file.categoryRules[0],
			id: 'planted',
			name: 'Planted',
			matchText: 'a{1000}',
			isRegex: true
		});

		const refusal = await restoreBackup(userId, file as BackupExport).catch((error) => error);

		expect(refusal).toBeInstanceOf(BackupImportError);
		expect((refusal as BackupImportError).reason).toBe('costly_category_rule');
		const left = await prisma.categoryRule.findMany({ where: { userId }, select: { name: true } });
		expect(left).toEqual([{ name: 'Auchan' }]);
	});

	it('restores a regex the engine cannot compile as it is, since it matched nothing on the source', async () => {
		// RULING 1, 2026-10-30. SEPARATES « only a pattern with a CPU cost is refused » FROM « every
		// pattern the rule form would refuse is refused ». A rule stored before RE2 may hold a
		// lookahead: it compiles to nothing, matches nothing, and refusing it would refuse the whole of
		// a user's own file. The long pattern is past the form's 80 character cap and inside F4's
		// ceiling, which is the one bound a restore applies.
		const userId = await freshUser(['Courses']);
		const long = Array.from({ length: 14 }, (_, i) => `shop${i}`).join('|');
		expect(compileRegex('(?=carte)carte'), 'the lookahead must not compile').toBeNull();
		expect(long.length).toBeGreaterThan(80);
		expect(compileRegex(long)!.programSize()).toBeLessThanOrEqual(160);
		for (const matchText of ['(?=carte)carte', long]) {
			await prisma.categoryRule.create({
				data: rule(userId, {
					name: matchText.slice(0, 20),
					matchText,
					targetCategory: 'Courses',
					isRegex: true
				})
			});
		}

		// A LITERAL rule is never compiled, so the cost check must not read its text as a pattern.
		await prisma.categoryRule.create({
			data: rule(userId, { name: 'Literal', matchText: 'a{1000}', targetCategory: 'Courses' })
		});

		await roundTrip(userId);

		const restored = await prisma.categoryRule.findMany({
			where: { userId, isRegex: true },
			select: { matchText: true, isRegex: true }
		});
		expect(await prisma.categoryRule.count({ where: { userId, isRegex: false } })).toBe(1);
		expect(restored.sort((a, b) => a.matchText.localeCompare(b.matchText))).toEqual(
			['(?=carte)carte', long]
				.sort((a, b) => a.localeCompare(b))
				.map((matchText) => ({ matchText, isRegex: true }))
		);
	});

	it("restores a suggested rule as custom when it no longer equals this version's pack entry", async () => {
		// RULING 2, 2026-10-30. SEPARATES « the key is kept only for a row still equal to the pack »
		// FROM « the key is kept as the file says ». A file exported before the 0819 migration holds
		// `boulanger` as a literal under its pack key: kept, it would be badged untouched, over-match
		// every BOULANGERIE, and never be tightened, because that migration does not run again.
		const userId = await freshUser([]);
		await ensureDefaultRulesSeeded(userId);
		const total = await prisma.categoryRule.count({ where: { userId } });
		const stale = await prisma.categoryRule.updateMany({
			where: { userId, defaultRuleKey: 'shopping_boulanger' },
			data: { matchText: 'boulanger', isRegex: false }
		});
		expect(stale.count, 'the catalog must still hold this key').toBe(1);
		// Same text, other mode: a literal is not the pack's regex, so the mode is compared too.
		const moded = await prisma.categoryRule.updateMany({
			where: { userId, defaultRuleKey: 'food_cora' },
			data: { isRegex: false }
		});
		expect(moded.count, 'the catalog must still hold this key').toBe(1);
		// Same mode, other text: a later pack edit of a regex, so the text is compared too.
		const texted = await prisma.categoryRule.updateMany({
			where: { userId, defaultRuleKey: 'food_spar' },
			data: { matchText: '\\bspar' }
		});
		expect(texted.count, 'the catalog must still hold this key').toBe(1);

		await roundTrip(userId);

		expect(
			await prisma.categoryRule.count({ where: { userId, defaultRuleKey: { not: null } } })
		).toBe(total - 3);
		const old = await prisma.categoryRule.findFirstOrThrow({
			where: { userId, matchText: 'boulanger' },
			select: { defaultRuleKey: true }
		});
		expect(old.defaultRuleKey).toBeNull();
		expect(await restoreMissingDefaultRules(userId)).toBe(3);
	});

	it('keeps the order of fifty rules sharing one timestamp', async () => {
		// SEPARATES « one createMany gives new ids in array order » FROM « it does not », which the
		// two-row tie above can satisfy by chance. Measures id generation, so it reads the order
		// with the matcher's own sort rather than through a classification.
		const userId = await freshUser([]);
		const at = new Date(Date.UTC(2026, 1, 1));
		for (let i = 49; i >= 0; i--) {
			await prisma.categoryRule.create({
				data: {
					...rule(userId, { name: `r${i}`, matchText: `m${i}`, targetCategory: 'Courses' }),
					id: `tie-${String(i).padStart(2, '0')}`,
					createdAt: at
				}
			});
		}
		const order = () =>
			prisma.categoryRule
				.findMany({
					where: { userId },
					orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
					select: { name: true }
				})
				.then((rows) => rows.map((row) => row.name));
		const before = await order();
		expect(before[0]).toBe('r0');

		await roundTrip(userId);

		expect(await order()).toEqual(before);
	});
});
