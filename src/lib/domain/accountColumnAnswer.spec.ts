import { describe, expect, it } from 'vitest';
import { readAccountColumnAnswer } from './accountColumnAnswer';

describe('readAccountColumnAnswer', () => {
	it('accepts each of the two closed-set answers', () => {
		expect(readAccountColumnAnswer('is-account')).toBe('is-account');
		expect(readAccountColumnAnswer('not-account')).toBe('not-account');
	});

	it('falls back to undefined rather than repairing an absent, empty or hostile value', () => {
		expect(readAccountColumnAnswer(null)).toBeUndefined();
		expect(readAccountColumnAnswer(undefined)).toBeUndefined();
		expect(readAccountColumnAnswer('')).toBeUndefined();
		expect(readAccountColumnAnswer('yes')).toBeUndefined();
		expect(readAccountColumnAnswer(new File([], 'x.csv'))).toBeUndefined();
	});
});
