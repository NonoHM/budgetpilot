import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATEGORY_NAME_REFERENCES } from './references.ts';

/**
 * The inventory in `references.ts` decides what a rename moves. Maintained by hand it is a list of
 * what its author thought of, which is precisely how `MonthlyBudget.categoryName` came to be left
 * behind — so it is checked against `prisma/schema.prisma` rather than trusted.
 *
 * The predicate is structural, not a restatement of the list: any `String` field whose NAME names a
 * category, minus the id columns (a real foreign key, which a rename does not touch) and the `*Key`
 * companions (the fold of a name in the same row, moved with it). A sixth column added to the
 * schema therefore fails this test by name instead of silently inheriting five sixths of a fix.
 *
 * Its honest limit, stated so nobody reads more into a green run than is there: it can only see
 * columns whose NAME says "category". A column called `bucket` holding a category name is invisible
 * to it, exactly as `CLAUDE.md`'s naming-convention entry describes — a name scopes only what it
 * can see. That is what the db-smoke walk over a real rename is for.
 */

type SchemaField = { model: string; column: string };

function categoryNameColumnsInSchema(): SchemaField[] {
	const schema = readFileSync(new URL('../../../../prisma/schema.prisma', import.meta.url), 'utf8');
	const found: SchemaField[] = [];
	const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
	let match: RegExpExecArray | null;
	while ((match = modelBlock.exec(schema)) !== null) {
		const [, model, body] = match;
		for (const rawLine of body.split('\n')) {
			const field = rawLine.trim().match(/^(\w+)\s+String\??(\s|$)/);
			if (!field) continue;
			const column = field[1];
			if (!/category/i.test(column)) continue;
			if (/Id$/.test(column) || /Key$/.test(column)) continue;
			found.push({ model, column });
		}
	}
	return found;
}

const asLabel = (ref: SchemaField) => `${ref.model}.${ref.column}`;

describe('the inventory of columns holding a category name', () => {
	it('is exactly what the schema holds — no column left behind, none invented', () => {
		const fromSchema = categoryNameColumnsInSchema().map(asLabel).sort();
		const fromInventory = CATEGORY_NAME_REFERENCES.map(asLabel).sort();

		// An absolute assertion, not a comparison of two hand-written lists: the left side is read
		// out of the schema at run time.
		expect(fromInventory).toEqual(fromSchema);
	});

	it('finds a real set rather than an empty one', () => {
		// The floor that makes the equality above mean something. Two empty arrays compare equal,
		// so a regex that stops matching — a schema reformat, a Prisma syntax change — would make
		// the test above pass while looking at nothing at all.
		expect(categoryNameColumnsInSchema().length).toBeGreaterThanOrEqual(5);
	});

	it('records which columns carry a fold key and which must be matched in JS', () => {
		// The two rule tables have no `*Key` companion, which is why `renameCategoryReferences`
		// cannot use a keyed `updateMany` for them. Pinned so that adding one later is a deliberate
		// change to this file rather than a silent drift in how they are matched.
		const keyless = CATEGORY_NAME_REFERENCES.filter((ref) => ref.keyColumn === null).map(asLabel);
		expect(keyless).toEqual(['CategoryRule.targetCategory', 'CategorizationRule.targetCategory']);

		for (const ref of CATEGORY_NAME_REFERENCES) {
			if (ref.keyColumn === null) continue;
			const schema = readFileSync(
				new URL('../../../../prisma/schema.prisma', import.meta.url),
				'utf8'
			);
			const model = schema.match(new RegExp(`^model\\s+${ref.model}\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
			expect(model, `${ref.model} is not in the schema`).not.toBeNull();
			expect(model?.[1], `${asLabel(ref)} claims a key column that does not exist`).toMatch(
				new RegExp(`^\\s*${ref.keyColumn}\\s+String`, 'm')
			);
		}
	});
});
