import { env } from '$env/dynamic/private';
import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { categorySetBy } from '$lib/domain/categorySetBy';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { applyCategoryRules } from '$lib/server/categorization/rules';
import { buildBackupExport } from '$lib/server/backup/export';
import { restoreBackup } from '$lib/server/backup/import';
import { resetCategoryAuthors } from './categoryAuthorsReset';
import { backupExportSchema } from '$lib/server/backup/schema';
import { actions as transactionActions } from '../../../routes/transactions/+page.server';
import { actions as categoryActions } from '../../../routes/categories/+page.server';

/**
 * #1013: every writer of a transaction's pin (`manualCategory`) records who set it, so a learner
 * can read « only what the member chose ». One test per writer, each driven through the code path
 * the application runs, each asserting the author READ BACK through `categorySetBy`, the one
 * reader, never the raw column. The writer list (8) is in the PR body: the six callers of
 * `manualCategoryUpdate`, the rename's direct write, and the boot key backfill (keys only).
 *
 * Every writer that takes a client-posted id is also given ANOTHER member's row, which must come
 * back untouched (ASVS v5.0.0-8.2.2), here and not in a unit spec whose fake decides what a
 * where clause matches.
 */

env.RATE_LIMIT_HASH_SECRET ??= 'c3'.repeat(32);

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

afterAll(async () => {
	if (createdUserIds.length > 0) {
		await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } });
		await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
	}
});

interface Seed {
	userId: string;
	accountId: string;
	categoryId: string;
	locals: { user: { id: string; email: string; role: string } };
}

async function seed(): Promise<Seed> {
	const email = `set-by-smoke-${crypto.randomUUID()}@budgetpilot.invalid`;
	const { id: userId } = await prisma.user.create({
		data: { email, passwordHash: 'db-smoke-not-a-real-hash' },
		select: { id: true }
	});
	createdUserIds.push(userId);
	const account = await prisma.account.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId,
			name: 'Compte courant',
			nameKey: computeNameKey('Compte courant'),
			source: 'csv'
		},
		select: { id: true }
	});
	const [bank] = await Promise.all(
		['Divers', 'Courses', 'Loisirs'].map((name) =>
			prisma.category.create({
				data: { userId, name, nameKey: computeNameKey(name) },
				select: { id: true }
			})
		)
	);
	return {
		userId,
		accountId: account.id,
		categoryId: bank.id,
		locals: { user: { id: userId, email, role: 'user' } }
	};
}

async function row(s: Seed, label = 'CARREFOUR MARKET'): Promise<string> {
	const created = await prisma.transaction.create({
		data: {
			...DEFAULT_DENOMINATION,
			userId: s.userId,
			accountId: s.accountId,
			categoryId: s.categoryId,
			date: new Date('2026-03-10T00:00:00.000Z'),
			label,
			amountCents: BigInt(4200),
			type: 'expense',
			source: 'csv'
		},
		select: { id: true }
	});
	return created.id;
}

async function setBy(id: string) {
	const found = await prisma.transaction.findUniqueOrThrow({
		where: { id },
		select: {
			manualCategory: true,
			manualCategoryKey: true,
			manualCategorySource: true,
			manualCategorySourceKey: true
		}
	});
	return { pin: found.manualCategory, author: categorySetBy(found) };
}

function post(action: (event: never) => unknown, path: string, fields: [string, string][]) {
	const formData = new FormData();
	for (const [name, value] of fields) formData.append(name, value);
	return (s: Seed) =>
		action({
			locals: s.locals,
			request: new Request(`http://localhost${path}`, { method: 'POST', body: formData })
		} as never);
}

describe('who set a category, per writer', () => {
	it('saveManualCategory records the member, and leaves another member’s row untouched', async () => {
		const s = await seed();
		const other = await seed();
		const mine = await row(s);
		const theirs = await row(other);

		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const refused = await post(
			transactionActions.saveManualCategory,
			'/transactions?/saveManualCategory',
			[
				['transactionId', theirs],
				['manualCategory', 'Courses']
			]
		)(s);

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'member' });
		expect(refused).toMatchObject({ status: 404 });
		expect(await setBy(theirs)).toEqual({ pin: null, author: null });
	});

	it('saveManualCategory clearing the pin clears its author', async () => {
		const s = await seed();
		const mine = await row(s);
		const save = (value: string) =>
			post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
				['transactionId', mine],
				['manualCategory', value]
			])(s);

		await save('Courses');
		await save('');

		const stored = await prisma.transaction.findUniqueOrThrow({
			where: { id: mine },
			select: { manualCategorySource: true, manualCategorySourceKey: true }
		});
		expect(stored).toEqual({ manualCategorySource: null, manualCategorySourceKey: null });
	});

	it('acceptSuggestion records an accepted suggestion, and leaves another member’s row untouched', async () => {
		const s = await seed();
		const other = await seed();
		const mine = await row(s);
		const theirs = await row(other);
		const accept = (id: string) =>
			post(transactionActions.acceptSuggestion, '/transactions?/acceptSuggestion', [
				['transactionId', id],
				['proposed', 'Courses'],
				['category', 'Courses'],
				['nature', ''],
				['seen', '{"category":null,"nature":null}']
			])(s);

		await accept(mine);
		const refused = await accept(theirs);

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'acceptedSuggestion' });
		expect(refused).toMatchObject({ status: 404 });
		expect(await setBy(theirs)).toEqual({ pin: null, author: null });
	});

	it('createRule in focus mode records the rule, and skips another member’s posted row', async () => {
		const s = await seed();
		const other = await seed();
		const mine = await row(s);
		const theirs = await row(other);

		await post(transactionActions.createRule, '/transactions?/createRule', [
			['name', 'Carrefour'],
			['matchText', 'CARREFOUR'],
			['targetCategory', 'Courses'],
			['targetNature', ''],
			['focusRemainingIds', mine],
			['focusRemainingIds', theirs]
		])(s);

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'rule' });
		expect(await setBy(theirs)).toEqual({ pin: null, author: null });
	});

	it('applyCategoryRules records the rule, never over the member’s pin, and only for its user', async () => {
		const s = await seed();
		const other = await seed();
		const free = await row(s);
		const chosen = await row(s);
		const theirs = await row(other);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', chosen],
			['manualCategory', 'Loisirs']
		])(s);
		await prisma.categoryRule.create({
			data: {
				userId: s.userId,
				name: 'Carrefour',
				matchText: 'CARREFOUR',
				targetCategory: 'Courses',
				enabled: true
			}
		});

		await applyCategoryRules(s.userId);

		expect(await setBy(free)).toEqual({ pin: 'Courses', author: 'rule' });
		expect(await setBy(chosen)).toEqual({ pin: 'Loisirs', author: 'member' });
		expect(await setBy(theirs)).toEqual({ pin: null, author: null });
	});

	it('renaming the category keeps the author of every pin that followed it', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const courses = await prisma.category.findFirstOrThrow({
			where: { userId: s.userId, nameKey: computeNameKey('Courses') },
			select: { id: true }
		});

		const other = await seed();
		const theirs = await row(other);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', theirs],
			['manualCategory', 'Courses']
		])(other);

		await post(categoryActions.renameCategory, '/categories?/renameCategory', [
			['id', courses.id],
			['newName', 'Alimentation']
		])(s);

		expect(await setBy(mine)).toEqual({ pin: 'Alimentation', author: 'member' });
		expect(await setBy(theirs)).toEqual({ pin: 'Courses', author: 'member' });
	});

	it('renaming leaves another member’s stale author where it is', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const other = await seed();
		const theirs = await row(other);
		const stale = {
			manualCategory: 'Courses',
			manualCategoryKey: computeNameKey('Courses'),
			manualCategorySource: 'member' as const,
			manualCategorySourceKey: computeNameKey('Loisirs')
		};
		await prisma.transaction.update({ where: { id: theirs }, data: stale });
		const courses = await prisma.category.findFirstOrThrow({
			where: { userId: s.userId, nameKey: computeNameKey('Courses') },
			select: { id: true }
		});

		await post(categoryActions.renameCategory, '/categories?/renameCategory', [
			['id', courses.id],
			['newName', 'Alimentation']
		])(s);

		const stored = await prisma.transaction.findUniqueOrThrow({
			where: { id: theirs },
			select: {
				manualCategory: true,
				manualCategoryKey: true,
				manualCategorySource: true,
				manualCategorySourceKey: true
			}
		});
		expect(stored).toEqual(stale);
	});

	it('renaming does not revive an author left behind for another pin', async () => {
		const s = await seed();
		const mine = await row(s);
		// A pin 1.3 wrote over a member's 1.4 « Loisirs »: the source still names the old key.
		await prisma.transaction.update({
			where: { id: mine },
			data: {
				manualCategory: 'Courses',
				manualCategoryKey: computeNameKey('Courses'),
				manualCategorySource: 'member',
				manualCategorySourceKey: computeNameKey('Loisirs')
			}
		});
		const courses = await prisma.category.findFirstOrThrow({
			where: { userId: s.userId, nameKey: computeNameKey('Courses') },
			select: { id: true }
		});

		await post(categoryActions.renameCategory, '/categories?/renameCategory', [
			['id', courses.id],
			['newName', 'Loisirs2']
		])(s);

		expect(await setBy(mine)).toEqual({ pin: 'Loisirs2', author: 'unknown' });
	});

	it('renaming onto the name a stale author was written for does not revive it', async () => {
		// Security review on ee917b1d: the stale author names « Courses », the pin is « Loisirs », and
		// « Loisirs » is renamed to « Courses », so the pin's new key equals the stale one.
		const s = await seed();
		const mine = await row(s);
		await prisma.transaction.update({
			where: { id: mine },
			data: {
				manualCategory: 'Loisirs',
				manualCategoryKey: computeNameKey('Loisirs'),
				manualCategorySource: 'member',
				manualCategorySourceKey: computeNameKey('Courses')
			}
		});
		const [courses, loisirs] = await Promise.all(
			['Courses', 'Loisirs'].map((name) =>
				prisma.category.findFirstOrThrow({
					where: { userId: s.userId, nameKey: computeNameKey(name) },
					select: { id: true }
				})
			)
		);
		await post(categoryActions.deleteCategory, '/categories?/deleteCategory', [['id', courses.id]])(
			s
		);

		await post(categoryActions.renameCategory, '/categories?/renameCategory', [
			['id', loisirs.id],
			['newName', 'Courses']
		])(s);

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'unknown' });
	});

	it('deleting the category clears every pin to it together with its author', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const courses = await prisma.category.findFirstOrThrow({
			where: { userId: s.userId, nameKey: computeNameKey('Courses') },
			select: { id: true }
		});

		const other = await seed();
		const theirs = await row(other);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', theirs],
			['manualCategory', 'Courses']
		])(other);

		await post(categoryActions.deleteCategory, '/categories?/deleteCategory', [['id', courses.id]])(
			s
		);

		expect(await setBy(theirs)).toEqual({ pin: 'Courses', author: 'member' });
		const stored = await prisma.transaction.findUniqueOrThrow({
			where: { id: mine },
			select: { manualCategory: true, manualCategorySource: true, manualCategorySourceKey: true }
		});
		expect(stored).toEqual({
			manualCategory: null,
			manualCategorySource: null,
			manualCategorySourceKey: null
		});
	});
});

describe('pins no writer of this version set', () => {
	it('reads unknown for a pin stored before the source existed', async () => {
		const s = await seed();
		const mine = await row(s);
		await prisma.transaction.update({
			where: { id: mine },
			data: { manualCategory: 'Courses', manualCategoryKey: computeNameKey('Courses') }
		});

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'unknown' });
	});

	it('reads unknown for a pin a 1.3 writer changed after a 1.4 member set it', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		// What 1.3 writes: the pin and its key, nothing else.
		await prisma.transaction.update({
			where: { id: mine },
			data: { manualCategory: 'Loisirs', manualCategoryKey: computeNameKey('Loisirs') }
		});

		expect(await setBy(mine)).toEqual({ pin: 'Loisirs', author: 'unknown' });
	});
});

describe('restore', () => {
	async function exported(userId: string) {
		return JSON.parse(JSON.stringify(await buildBackupExport(userId)));
	}

	it('brings back each author, and unknown stays unknown', async () => {
		const s = await seed();
		const byMember = await row(s, 'BOULANGERIE');
		const byRule = await row(s, 'CARREFOUR MARKET');
		const before = await row(s, 'CINEMA');
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', byMember],
			['manualCategory', 'Courses']
		])(s);
		await post(transactionActions.createRule, '/transactions?/createRule', [
			['name', 'Carrefour'],
			['matchText', 'CARREFOUR'],
			['targetCategory', 'Courses'],
			['targetNature', ''],
			['focusRemainingIds', byRule]
		])(s);
		await prisma.transaction.update({
			where: { id: before },
			data: { manualCategory: 'Loisirs', manualCategoryKey: computeNameKey('Loisirs') }
		});

		await restoreBackup(s.userId, backupExportSchema.parse(await exported(s.userId)));

		const restored = await prisma.transaction.findMany({
			where: { userId: s.userId },
			select: {
				label: true,
				manualCategoryKey: true,
				manualCategorySource: true,
				manualCategorySourceKey: true
			}
		});
		const authors = Object.fromEntries(restored.map((r) => [r.label, categorySetBy(r)]));
		expect(authors).toEqual({
			BOULANGERIE: 'member',
			'CARREFOUR MARKET': 'rule',
			CINEMA: 'unknown'
		});
	});

	it('exports a stale author as unknown, so a round trip cannot launder it', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		await prisma.transaction.update({
			where: { id: mine },
			data: { manualCategory: 'Loisirs', manualCategoryKey: computeNameKey('Loisirs') }
		});

		const file = await exported(s.userId);

		expect(file.transactions[0].manualCategorySource).toBe(null);
	});

	it('reads a file written before the field existed as unknown', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const file = await exported(s.userId);
		delete file.transactions[0].manualCategorySource;

		await restoreBackup(s.userId, backupExportSchema.parse(file));

		const [restored] = await prisma.transaction.findMany({
			where: { userId: s.userId },
			select: { manualCategoryKey: true, manualCategorySource: true, manualCategorySourceKey: true }
		});
		expect(categorySetBy(restored)).toBe('unknown');
	});

	it('refuses a file naming an author for a row that carries no pin', async () => {
		const s = await seed();
		await row(s);
		const file = await exported(s.userId);
		file.transactions[0].manualCategorySource = 'member';

		const parsed = backupExportSchema.safeParse(file);

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path.at(-1))).toEqual([
			'manualCategorySource'
		]);
	});

	it('refuses a file naming an author beside an empty category', async () => {
		const s = await seed();
		await row(s);
		const file = await exported(s.userId);
		file.transactions[0].manualCategory = '';
		file.transactions[0].manualCategorySource = 'member';

		const parsed = backupExportSchema.safeParse(file);

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path.at(-1))).toEqual([
			'manualCategorySource'
		]);
	});

	it('the schema accepts an author beside a whitespace pin, which a restored rule can write', async () => {
		// Narrow pass on the fix: a blank-after-trim check would refuse the member's own export.
		const s = await seed();
		await row(s);
		const file = await exported(s.userId);
		file.transactions[0].manualCategory = '  ';
		file.transactions[0].manualCategorySource = 'rule';

		expect(backupExportSchema.safeParse(file).success).toBe(true);
	});

	it('refuses an author outside the closed list', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const file = await exported(s.userId);
		file.transactions[0].manualCategorySource = 'model';

		const parsed = backupExportSchema.safeParse(file);

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.path.at(-1))).toEqual([
			'manualCategorySource'
		]);
	});
});

describe('the operator reset after rolling forward', () => {
	// The case the key check cannot see (contradiction pass on the design note, confirmed at tag
	// budgetpilot-v1.3.0): 1.3 clears a pin without its author, then a rule re-sets the SAME name,
	// so the stale author's key matches again. The first assertion records the limit, so a change
	// that closes it differently turns this red and says so; the reset is the ruled answer.
	it('a 1.3 clear then a rule re-pin of the same name reads the member until the reset', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		// 1.3's clear and 1.3's rule write: the pin and its key, nothing else.
		await prisma.transaction.update({
			where: { id: mine },
			data: { manualCategory: null, manualCategoryKey: null }
		});
		await prisma.transaction.update({
			where: { id: mine },
			data: { manualCategory: 'Courses', manualCategoryKey: computeNameKey('Courses') }
		});
		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'member' });

		await resetCategoryAuthors(prisma, { dryRun: false });

		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'unknown' });
	});

	it('a dry run counts the authors it would forget and writes nothing', async () => {
		const s = await seed();
		const mine = await row(s);
		await post(transactionActions.saveManualCategory, '/transactions?/saveManualCategory', [
			['transactionId', mine],
			['manualCategory', 'Courses']
		])(s);
		const stored = await prisma.transaction.count({
			where: { manualCategorySource: { not: null } }
		});

		const counted = await resetCategoryAuthors(prisma, { dryRun: true });

		expect(stored).toBeGreaterThan(0);
		expect(counted).toBe(stored);
		expect(await setBy(mine)).toEqual({ pin: 'Courses', author: 'member' });
	});
});
