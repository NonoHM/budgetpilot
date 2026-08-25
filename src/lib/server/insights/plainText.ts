/**
 * Markdown markers out of model-generated text, at RECEPTION (#524 follow-up).
 *
 * A local model emits « **35%** » into an insight and the reader sees the asterisks, because two
 * things are both true and neither is enforced: `localLlmJsonSchema` constrains the free-text fields
 * by `maxLength` alone, and the prompt never says the output is rendered as plain text. So what
 * appears on screen depends on which model the operator happened to pull. That is a correctness
 * property of the output, not a matter of taste.
 *
 * STRIPPED, NEVER RENDERED, and the distinction is the whole design. Rendering the markdown would
 * mean turning generated text into markup, and `{@html}` appears zero times in this tree on purpose.
 * `DashboardInsights.svelte` interpolates `{item.message}`, which escapes, so the current defect is
 * cosmetic rather than a hole. Stripping is what keeps it that way while fixing what the reader sees.
 *
 * NOT `sanitizeImportedText`, deliberately, despite the similar shape. That one exists for CSV cells:
 * it normalises mojibake and prefixes an apostrophe onto a leading `-` or `=` to defuse spreadsheet
 * formula injection. Applied here it would put a stray apostrophe in front of any insight that opens
 * with a dash, which is a sentence a model writes often. Same verb, different contract.
 *
 * A PURE FUNCTION of its input: no clock, no locale, no network. It runs before the text is handed
 * on, so anything derived from it has to be rebuildable from what was stored (AGENTS.md, "Code
 * style").
 */

/** `[label](https://…)` keeps the label and drops the target. A model has no business linking here. */
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** Inline code spans, including the doubled form used to embed a literal backtick. */
const CODE_SPAN = /`{1,3}([^`]*)`{1,3}/g;

/**
 * `*text*`, `**text**`, `***text***`. Safe to match greedily on the delimiter count because `*` is
 * not a word character, so it cannot occur inside an identifier the way `_` can.
 */
const ASTERISK_EMPHASIS = /\*{1,3}(?=\S)([\s\S]*?\S)\*{1,3}/g;

/**
 * `_text_` and `__text__`, and the guard is the reason this is a separate pattern from the one above.
 * An underscore IS a word character, so a naive rule rewrites `CARREFOUR_MARKET_2` into
 * `CARREFOURMARKET2`. Requiring a non-word character (or a boundary) on the outside of each
 * delimiter means an underscore inside a word is left exactly as the model wrote it.
 */
const UNDERSCORE_EMPHASIS = /(^|[^\w])_{1,3}(?=\S)([\s\S]*?\S)_{1,3}(?!\w)/g;

/** A leading `#`, `-`, `*` or `>` marker on a line, with the space that follows it. */
const LEADING_BLOCK_MARKER = /^[ \t]*(?:#{1,6}|[-*+>])[ \t]+/gm;

/**
 * Removes markdown markers and keeps the text they wrapped.
 *
 * Order matters and is not arbitrary: links first, so a bolded link keeps its label rather than
 * losing it to the emphasis pass; then code spans; then emphasis; then the line-leading markers,
 * which can only be recognised once inline markers are gone.
 */
export function stripMarkdown(value: string): string {
	return value
		.replace(MARKDOWN_LINK, '$1')
		.replace(CODE_SPAN, '$1')
		.replace(ASTERISK_EMPHASIS, '$1')
		.replace(UNDERSCORE_EMPHASIS, '$1$2')
		.replace(LEADING_BLOCK_MARKER, '')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}
