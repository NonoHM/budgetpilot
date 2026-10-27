import { describe, expect, it } from 'vitest';
import { REGISTRY } from './events';
import { EVENT } from './names';

/**
 * A summarised event's `floodBy` fields are copied onto its `budgetpilot.log.suppressed` line
 * (`core.ts`), so each one must be declared on that event too, or the summary writes a field with
 * no classification level and no documentation (L4b note pass, finding 3). The calibration is that
 * the events with a `floodBy` are found at all.
 */
describe('every floodBy field is declared on the summary line', () => {
	const declared = Object.keys(REGISTRY[EVENT.logSuppressed].attributes);
	const keyed = Object.entries(REGISTRY).filter(([, spec]) => spec.floodBy !== undefined);

	it('finds the events that split their summary by a field', () => {
		expect(keyed.length).toBeGreaterThanOrEqual(4);
	});

	it('finds no floodBy field missing from log.suppressed', () => {
		expect(
			keyed.flatMap(([name, spec]) =>
				(spec.floodBy ?? [])
					.filter((key) => !declared.includes(key))
					.map((key) => `${name}: ${key}`)
			)
		).toEqual([]);
	});
});
