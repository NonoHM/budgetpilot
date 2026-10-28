import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE NAME-KEY MERGE DELETES ROWS, SO IT OWES EVERY ROW POINTING AT THEM A NEW HOME (#1086).
 *
 * `backfill.ts` folds duplicate categories and accounts into a survivor and deletes the losers.
 * Whatever references a loser either blocks that delete (no cascade) or dies with it (cascade),
 * and the second is silent: import batches and remembered answers went that way, measured on a
 * real engine. A new table pointing at `Account` or `Category` would go the same way the day it
 * is added, so this reads the relations from the schema rather than from a list kept by hand.
 *
 * What it can see: that the loop deleting a target issues a `tx.<model>.updateMany` filtering the
 * relation's own column on `loserIds`. Scoped to that loop because `Transaction` points at both
 * targets, so a match anywhere in the file let the category loop's repoint stand in for a deleted
 * account one. What it cannot see: that the update writes the survivor. The db-smoke tests in
 * `database/crossProvider.db-smoke.ts` assert that, on three engines, for the relations they cover.
 */

/** Each target, and the loop in `backfill.ts` that deletes its losers. */
const LOOPS: Record<string, string> = {
	Account: 'for (const merge of accountPlan.merges)',
	Category: 'for (const merge of categoryMerges)'
};

/** `Target:Model.column` for every relation onto a target. */
function relationsOnto(targets: string[]): string[] {
	const schema = readFileSync('prisma/schema.prisma', 'utf8');
	const found: string[] = [];
	let model = '';
	for (const line of schema.split('\n')) {
		const header = /^model (\w+) \{/.exec(line);
		if (header) model = header[1];
		const relation = /^\s+\w+\s+(\w+)\??\s+@relation\(fields: \[(\w+)\]/.exec(line);
		if (relation && targets.includes(relation[1])) {
			found.push(`${relation[1]}:${model}.${relation[2]}`);
		}
	}
	return found;
}

/** The text of the loop deleting `target` rows, up to the next merge loop. */
function loopFor(source: string, target: string): string {
	const start = source.indexOf(LOOPS[target]);
	if (start < 0) throw new Error(`backfill.ts has no « ${LOOPS[target]} »`);
	const next = source.indexOf('for (const merge of', start + 1);
	return source.slice(start, next < 0 ? undefined : next);
}

function repoints(source: string, entry: string): boolean {
	const [target, relation] = entry.split(':');
	const [model, column] = relation.split('.');
	const delegate = model[0].toLowerCase() + model.slice(1);
	return new RegExp(
		`tx\\.${delegate}\\.updateMany\\(\\{\\s*where: \\{[^}]*\\b${column}: \\{ in: loserIds \\}`
	).test(loopFor(source, target));
}

describe('the name-key merge', () => {
	const relations = relationsOnto(Object.keys(LOOPS));
	const source = readFileSync('src/lib/server/naming/backfill.ts', 'utf8');

	it('reads the relations it guards (calibration: three that exist today)', () => {
		expect(relations).toEqual(
			expect.arrayContaining([
				'Account:Transaction.accountId',
				'Category:Transaction.categoryId',
				'Category:TransactionSplit.categoryId'
			])
		);
	});

	it('repoints every relation onto a row it deletes', () => {
		expect(relations.filter((relation) => !repoints(source, relation))).toEqual([]);
	});
});
