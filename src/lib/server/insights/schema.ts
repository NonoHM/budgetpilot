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

/**
 * The worst-case serialised length the grammar above permits, in characters.
 *
 * WHY THIS IS COMPUTABLE AT ALL, and it is the property the fix rests on: nothing in
 * `localLlmJsonSchema` is unbounded. Every string carries `maxLength`, both enums are closed sets,
 * and `insights` carries `maxItems`. So the largest response the model is ALLOWED to produce is a
 * constant, and a generation ceiling set above it can never truncate.
 *
 * Derived by walking the schema OBJECT rather than by restating its numbers. That is the whole
 * point: `num_predict` was a literal 512 that never moved when the schema did, and a second literal
 * here would drift the same way. Adding a field or raising a `maxLength` moves this automatically.
 *
 * `ESCAPE_FACTOR` is the one honest approximation. `maxLength` counts CHARACTERS, and a character
 * that needs escaping (a quote, a backslash, a control character) costs two or more once serialised.
 * A merchant name or a French sentence is overwhelmingly unescaped, so 1.1 is generous for real text
 * while keeping the figure meaningful; the alternative, assuming every character escapes, doubles
 * the bound to guard against a string that cannot occur here.
 */
const ESCAPE_FACTOR = 1.1;

type JsonSchemaNode = {
	readonly type: string;
	readonly maxLength?: number;
	readonly enum?: readonly string[];
	readonly maxItems?: number;
	readonly items?: JsonSchemaNode;
	readonly properties?: { readonly [key: string]: JsonSchemaNode };
};

/**
 * Serialised size of the largest value this node admits, quotes and punctuation included.
 *
 * Exported for its own test: the unsupported-type throw is the guard that stops a new schema node
 * from silently contributing zero and SHRINKING the ceiling, and there is no other way to hand it
 * a node this schema does not contain.
 */
export function maxNodeChars(node: JsonSchemaNode): number {
	if (node.type === 'string') {
		// A closed enum is bounded by its longest member, which is tighter than any maxLength.
		const longest = node.enum
			? Math.max(...node.enum.map((member) => member.length))
			: (node.maxLength ?? 0);
		return Math.ceil(longest * ESCAPE_FACTOR) + 2; // + the two quotes
	}

	if (node.type === 'array') {
		const items = node.items;
		const maxItems = node.maxItems ?? 0;
		if (!items || maxItems === 0) return 2; // []
		// [item,item,...] : the brackets, every item, and one comma between each pair.
		return 2 + maxItems * maxNodeChars(items) + Math.max(0, maxItems - 1);
	}

	if (node.type === 'object') {
		const entries = Object.entries(node.properties ?? {});
		if (entries.length === 0) return 2; // {}
		// {"key":value,...} : the braces, each quoted key plus its colon, each value, and the commas.
		const body = entries.reduce(
			(total, [key, value]) => total + key.length + 3 + maxNodeChars(value),
			0
		);
		return 2 + body + Math.max(0, entries.length - 1);
	}

	// Every node in this schema is one of the three above. A new `type` must be sized deliberately
	// rather than silently contributing zero, which would make the ceiling too small and truncate.
	throw new Error(`maxNodeChars: unsupported JSON schema type "${node.type}"`);
}

/** The bound above, as one number, computed from the schema each time it is asked for. */
export function maxSerializedResponseChars(): number {
	return maxNodeChars(localLlmJsonSchema as unknown as JsonSchemaNode);
}

/**
 * The generation ceiling handed to Ollama as `num_predict`.
 *
 * It was a literal 512 from the initial public release and was never revisited, while the schema
 * was. Measured against the schema at #524's follow-up: the worst case is 2 142 characters, which is
 * ~536 tokens at a generous 4 chars per token and ~857 at 2.5, so 512 was below the schema's own
 * maximum in EVERY estimate. A fully populated five-insight French response could not fit even with
 * no reasoning tokens at all. A thinking model did not create that; it made a reachable failure the
 * common one, and the symptom was a 200 response whose JSON stopped mid-object.
 *
 * `CHARS_PER_TOKEN_FLOOR` is a conservative estimate rather than a proof, and saying so is the
 * point: the CHARACTER bound above is exact, and no character count can be converted to a token
 * count without the model's tokenizer. 2.5 is the pessimistic end for accented French under a modern
 * BPE tokenizer, where English prose sits nearer 4. `HEADROOM_TOKENS` covers the few tokens a chat
 * response spends on structure before the first character of content.
 */
const CHARS_PER_TOKEN_FLOOR = 2.5;
const HEADROOM_TOKENS = 128;

export function localLlmNumPredict(): number {
	return Math.ceil(maxSerializedResponseChars() / CHARS_PER_TOKEN_FLOOR) + HEADROOM_TOKENS;
}

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
