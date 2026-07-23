import { describe, expect, it } from 'vitest';
import { localLlmResponseSchema } from './schema';

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
