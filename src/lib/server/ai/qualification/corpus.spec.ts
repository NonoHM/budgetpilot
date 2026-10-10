import { describe, expect, it } from 'vitest';
import {
	FIXTURES,
	INPUT_ITEMS,
	INPUT_RULES,
	OUTPUT_ITEMS,
	OUTPUT_RULES,
	REAL_MODEL_FIXTURES
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
		expect([OUTPUT_RULES.length, INPUT_RULES.length]).toEqual([11, 9]);
	});

	it('expects a drop only from the rule the item is about, and a shown text from its twins', () => {
		for (const item of OUTPUT_ITEMS) {
			if ('dropped' in item.expect) {
				expect(item.fires, `${item.id} drops, so it fires`).toBe(true);
				expect(item.expect.dropped, item.id).toBe(item.rule);
			} else {
				expect(item.expect.shown.title.length, item.id).toBeGreaterThan(0);
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
