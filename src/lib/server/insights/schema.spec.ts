import { describe, expect, it } from 'vitest';
import {
	localLlmNumPredict,
	localLlmResponseSchema,
	maxNodeChars,
	maxSerializedResponseChars
} from './schema';

describe('localLlmResponseSchema', () => {
	it('accepte une réponse conforme au schéma', () => {
		expect.assertions(2);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé du mois',
			insights: [
				{
					title: 'Budget Loisirs dépassé',
					message: 'Vous avez dépassé votre budget Loisirs de 20 euros ce mois-ci.',
					severity: 'warning',
					category: 'budget'
				}
			]
		});

		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.insights).toHaveLength(1);
	});

	it('rejette un champ requis manquant (title) au lieu de le tronquer silencieusement', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: [
				{
					message: 'Un conseil sans titre',
					severity: 'info',
					category: 'budget'
				}
			]
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette un type incorrect (severity numérique)', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: [
				{
					title: 'Titre',
					message: 'Message',
					severity: 1,
					category: 'budget'
				}
			]
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette une chaîne dépassant .max() plutôt que de la tronquer', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'x'.repeat(161),
			insights: []
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette un message d’insight dépassant .max()', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: [
				{
					title: 'Titre',
					message: 'x'.repeat(241),
					severity: 'info',
					category: 'budget'
				}
			]
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette une valeur d’enum severity invalide', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: [
				{
					title: 'Titre',
					message: 'Message',
					severity: 'catastrophic',
					category: 'budget'
				}
			]
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette une valeur d’enum category invalide', () => {
		expect.assertions(1);

		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: [
				{
					title: 'Titre',
					message: 'Message',
					severity: 'info',
					category: 'invalide'
				}
			]
		});

		expect(parsed.success).toBe(false);
	});

	it('rejette plus de 5 insights', () => {
		expect.assertions(1);

		const insight = {
			title: 'Titre',
			message: 'Message',
			severity: 'info',
			category: 'budget'
		};
		const parsed = localLlmResponseSchema.safeParse({
			summary: 'Résumé',
			insights: Array.from({ length: 6 }, () => insight)
		});

		expect(parsed.success).toBe(false);
	});
});

/**
 * THE GENERATION CEILING MUST COVER WHAT THE SCHEMA PERMITS (#524 follow-up).
 *
 * `num_predict` was a literal 512 from the initial public release. The schema changed and the
 * literal did not, which is the same drift that put three different `LLM_TIMEOUT_MS` values in three
 * files. Measured: the schema's worst case is 2 328 serialised characters, roughly 930 tokens at the
 * pessimistic 2.5 chars per token used for accented French, so a fully populated five-insight French
 * response could not fit in 512 even with no reasoning tokens at all.
 *
 * The symptom was a 200 response in 4.7 s whose JSON stopped mid-object, reported to the reader as
 * « Assistant IA indisponible ». Changing to a thinking model did not create the defect; reasoning
 * tokens spend the same budget, so it turned a reachable failure into the common one.
 */
describe('local LLM generation ceiling', () => {
	it('bounds a MAXIMAL response built from the schema own limits, not from restated numbers', () => {
		expect.assertions(2);

		// Constructed from the limits rather than from `maxSerializedResponseChars`, so the two do not
		// share a source: if the walker under-counts a field, this fixture overflows its answer.
		// Accented characters on purpose, because they are what the French catalogue actually produces
		// and what makes the token estimate pessimistic.
		const maximal = {
			summary: 'é'.repeat(160),
			insights: Array.from({ length: 5 }, () => ({
				title: 'é'.repeat(80),
				message: 'é'.repeat(240),
				severity: 'critical' as const,
				category: 'recurring' as const
			}))
		};

		// Separates "the biggest response the schema ALLOWS" from "a big response". A fixture the
		// schema would reject is not the worst legal case, and bounding it would prove nothing.
		expect(localLlmResponseSchema.safeParse(maximal).success).toBe(true);
		expect(JSON.stringify(maximal).length).toBeLessThanOrEqual(maxSerializedResponseChars());
	});

	it('asks for more tokens than the worst case needs, and more than the 512 that truncated', () => {
		expect.assertions(2);

		// 2.5 is the pessimistic chars-per-token floor documented beside `localLlmNumPredict`. Restated
		// here on purpose: this assertion is the RELATIONSHIP between the two constants, so lowering
		// the ceiling or loosening the floor without re-deriving the other has to redden something.
		expect(localLlmNumPredict() * 2.5).toBeGreaterThanOrEqual(maxSerializedResponseChars());

		// Reproduces the original figure, per AGENTS.md: the red must bring back the measured value.
		expect(localLlmNumPredict()).toBeGreaterThan(512);
	});

	it('refuses a schema node it cannot size, rather than counting it as zero', () => {
		expect.assertions(1);

		// The confident-zero guard. An unsupported `type` contributing 0 would SHRINK the ceiling and
		// truncate exactly the field that was added, while every existing assertion here stayed green.
		// Separates "the walker handled the new node" from "the walker ignored it".
		expect(() => maxNodeChars({ type: 'number' })).toThrow(/unsupported JSON schema type/);
	});
});
