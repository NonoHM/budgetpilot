import { describe, expect, it } from 'vitest';
import { categorySetBy } from './categorySetBy';

// Each case separates two states a learner must tell apart (#1013): a pin it may learn from and
// one it must not. The key comparison is the rollback guard: 1.3 writes the pin and its key but
// never the source, so a pin 1.3 changed carries a source written for another key.
describe('categorySetBy', () => {
	it('reads no author when the row carries no pin', () => {
		expect(
			categorySetBy({
				manualCategoryKey: null,
				manualCategorySource: null,
				manualCategorySourceKey: null
			})
		).toBe(null);
	});

	it('reads the member when the source was written for the pin the row carries', () => {
		expect(
			categorySetBy({
				manualCategoryKey: 'courses',
				manualCategorySource: 'member',
				manualCategorySourceKey: 'courses'
			})
		).toBe('member');
	});

	it('reads a rule when the source was written for the pin the row carries', () => {
		expect(
			categorySetBy({
				manualCategoryKey: 'courses',
				manualCategorySource: 'rule',
				manualCategorySourceKey: 'courses'
			})
		).toBe('rule');
	});

	it('reads unknown for a pin written before the source existed', () => {
		expect(
			categorySetBy({
				manualCategoryKey: 'courses',
				manualCategorySource: null,
				manualCategorySourceKey: null
			})
		).toBe('unknown');
	});

	it('reads unknown for a pin changed by a writer that left an older source behind', () => {
		expect(
			categorySetBy({
				manualCategoryKey: 'loisirs',
				manualCategorySource: 'member',
				manualCategorySourceKey: 'courses'
			})
		).toBe('unknown');
	});

	it('reads no author for a pin cleared by a writer that left an older source behind', () => {
		expect(
			categorySetBy({
				manualCategoryKey: null,
				manualCategorySource: 'member',
				manualCategorySourceKey: 'courses'
			})
		).toBe(null);
	});
});
