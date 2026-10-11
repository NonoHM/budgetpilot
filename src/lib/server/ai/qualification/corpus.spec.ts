import { describe, expect, it } from 'vitest';
import {
	FIXTURES,
	INPUT_ITEMS,
	INPUT_RULES,
	OUTPUT_ITEMS,
	OUTPUT_RULES,
	REAL_MODEL_FIXTURES,
	SIBLING,
	TEXT_ATTACKS
} from './corpus';

/**
 * The corpus's own shape (#971). The suites that READ it are e2e (`e2e/ai-qualification.spec.ts`)
 * and `npm run ai:check`; this checks what makes their figures mean something.
 */
describe('AI qualification corpus', () => {
	it('names each item once', () => {
		const ids = [...OUTPUT_ITEMS, ...INPUT_ITEMS].map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// A rule with only firing items passes a rule that fires on everything; one with only twins passes
	// a rule that fires on nothing. The figure is absolute so a removed rule is a failure here.
	it.each([
		...OUTPUT_RULES.map((rule) => ['output', rule]),
		...INPUT_RULES.map((rule) => ['input', rule])
	])('%s rule %s has an item that must fire it and one that must not', (side, rule) => {
		const items = (side === 'output' ? OUTPUT_ITEMS : INPUT_ITEMS).filter(
			(item) => item.rule === rule
		);
		expect(items.filter((item) => item.fires).length, `${rule} must-fire items`).toBeGreaterThan(0);
		expect(
			items.filter((item) => !item.fires).length,
			`${rule} must-not-fire items`
		).toBeGreaterThan(0);
	});

	it('counts the rules the design names, so none is dropped unnoticed', () => {
		expect([OUTPUT_RULES.length, INPUT_RULES.length]).toEqual([6, 9]);
	});

	// #996: a refusal comes from one rule each. An unreadable answer is the grammar's verdict, a
	// withheld one is every pick dropped; any other item ends in statements the card shows.
	it('expects each failure only from the rule that produces it, and statements from every twin', () => {
		for (const item of OUTPUT_ITEMS) {
			if (!('failureCode' in item.expect)) continue;
			expect([item.rule, item.fires], `${item.id} expects ${item.expect.failureCode}`).toEqual(
				item.expect.failureCode === 'response_unusable' ? ['schema', true] : ['withheld', true]
			);
		}
		const failing = OUTPUT_ITEMS.filter((item) => 'failureCode' in item.expect).length;
		const showing = OUTPUT_ITEMS.filter((item) => 'statements' in item.expect).length;
		expect(failing + showing, 'every item is one or the other').toBe(OUTPUT_ITEMS.length);
		expect(failing, 'some items refuse').toBeGreaterThan(0);
		expect(showing, 'some items show').toBeGreaterThan(0);
	});

	// « Dropped, not refused »: an item that drops its pick still shows the sibling, so the empty
	// place is the rule acting on the pick and not the answer refused.
	it('keeps the sibling on the card wherever a rule drops one pick', () => {
		const dropping = OUTPUT_ITEMS.filter(
			(item) => item.fires && ['scope', 'alias', 'fact', 'repeat'].includes(item.rule)
		);
		expect(dropping.length, 'the items that drop a pick').toBeGreaterThan(0);
		for (const item of dropping) {
			expect('statements' in item.expect && item.expect.statements, item.id).toContain(SIBLING.id);
		}
	});

	// The port of the literature pass: each attack once as a kind and once as an alias, refused.
	it('carries every text attack as a kind and as an alias, each refused as unreadable', () => {
		expect(TEXT_ATTACKS.length, 'the attacks of the literature pass').toBe(12);
		for (const { text } of TEXT_ATTACKS) {
			for (const field of ['kind', 'category'] as const) {
				const carrying = OUTPUT_ITEMS.filter((item) =>
					(item.answer.picks as { kind: unknown; category: unknown }[] | undefined)?.some(
						(pick) => pick[field] === text
					)
				);
				expect(
					carrying.map((item) => [item.rule, item.expect]),
					`${JSON.stringify(text)} as ${field}`
				).toEqual([['schema', { failureCode: 'response_unusable' }]]);
			}
		}
	});

	it('gives every input item a positive, so an empty request cannot pass it', () => {
		for (const item of INPUT_ITEMS) expect(item.expect.present.length, item.id).toBeGreaterThan(0);
	});

	it('keeps every fixture inside the five categories the payload carries', () => {
		for (const [id, fixture] of Object.entries(FIXTURES)) {
			const spending = new Set(
				fixture.transactions.filter((t) => t.amount.startsWith('-')).map((t) => t.category)
			);
			expect(spending.size, id).toBeLessThanOrEqual(5);
			for (const t of fixture.transactions)
				expect(t.amount, `${id} ${t.label}`).toMatch(/^-?\d+\.\d{2}$/);
		}
	});

	it('keeps every category name within the 60 characters the writers accept', () => {
		for (const fixture of Object.values(FIXTURES)) {
			for (const t of fixture.transactions)
				expect([...t.category].length, t.category).toBeLessThanOrEqual(60);
		}
	});

	it('asks a real model about fixtures that exist, with a canary absent from its own prompt', () => {
		for (const entry of REAL_MODEL_FIXTURES) {
			expect(FIXTURES[entry.fixture], entry.fixture).toBeDefined();
			if (!entry.canary) continue;
			const stored = FIXTURES[entry.fixture].transactions
				.map((t) => `${t.label} ${t.category}`)
				.join(' ');
			// The calibration that matters: what the fixture stores must not already match the canary,
			// or a model quoting a name reads as a model obeying it.
			expect(entry.canary.pattern.test(stored), `${entry.fixture} stores its own canary`).toBe(
				false
			);
			// The positive control must be able to fire: the detector matches the answer it asks for.
			expect(entry.canary.ask.length, `${entry.fixture} asks for its canary`).toBeGreaterThan(0);
		}
	});
});
