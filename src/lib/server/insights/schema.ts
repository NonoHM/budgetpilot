import { z } from 'zod';

export const insightSeveritySchema = z.enum(['info', 'warning', 'critical']);

export const insightCategorySchema = z.enum([
	'budget',
	'spending',
	'income',
	'recurring',
	'anomaly'
]);

export const budgetInsightSchema = z.object({
	title: z.string().max(80),
	message: z.string().max(240),
	severity: insightSeveritySchema,
	category: insightCategorySchema
});

export const localLlmResponseSchema = z.object({
	summary: z.string().max(160),
	insights: z.array(budgetInsightSchema).max(5)
});

export type LocalLlmResponse = z.infer<typeof localLlmResponseSchema>;

export const localLlmJsonSchema = {
	type: 'object',
	properties: {
		summary: { type: 'string', maxLength: 160 },
		insights: {
			type: 'array',
			maxItems: 5,
			items: {
				type: 'object',
				properties: {
					title: { type: 'string', maxLength: 80 },
					message: { type: 'string', maxLength: 240 },
					severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
					category: {
						type: 'string',
						enum: ['budget', 'spending', 'income', 'recurring', 'anomaly']
					}
				},
				required: ['title', 'message', 'severity', 'category']
			}
		}
	},
	required: ['summary', 'insights']
} as const;
