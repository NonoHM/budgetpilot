import { normalizeForMatch } from '$lib/domain/normalize';
import type { CategoryBudgetSummary } from '$lib/domain/budget';
import { stripMarkdown } from '$lib/server/insights/plainText';
import { severityForBudgetStatus } from '$lib/server/insights/rules';
import type { BudgetInsight, InsightSeverity, LocalAiAdvice } from '$lib/server/insights/types';
import { CARD_LANGUAGES } from './cardLanguages';
import { policyBreach } from './policy';

/**
 * WHAT THE APP ACCEPTS FROM THE MODEL (G3, #969 and #831). The schema says an answer has the right
 * shape; this decides which of its statements reach the card, and what the card shows beside them.
 *
 * THE MODEL WRITES NO NUMBER. DENY BY DEFAULT, the owner's ruling of 2026-10-11. A small local model
 * misreads numbers, and a hostile one (attacker 2 of the gateway design: whatever answers at the
 * allowlisted address) writes any number it likes. So a statement holding a digit in any script, or a
 * word that is a magnitude, is dropped, and the card shows beside each statement the figure of every
 * category it names, taken from the payload by the app. The figure channel has ONE source.
 *
 * The rejected alternative is on record: checking each number against the payload. Three
 * contradiction passes in one day each found a new way around it (a colon, a sign, a unit, a
 * currency, a separator read the other way), because a check of that shape lists what CHANGES a
 * number's meaning, and that list never closes. The research note is
 * `docs/superpowers/2026-10-11-g3-figure-policy-research.md`; the cost measured in design rev 3 was
 * a number in 1 of 56 statements, and the prompt now asks for none.
 *
 * Everything here reads the SHOWN text: cleaned first, then checked, then shown exactly as checked.
 * A check run on any other string can be passed by a spelling a later step rewrites.
 *
 * A pure function of the answer and the payload: no clock, no locale, no network.
 */

export interface GroundingCategory {
	/** The category name as stored, the way the payload carries it to the model. */
	name: string;
	amountCents: number;
	/** The budget status of the category, or null when it has no budget this period. */
	status: CategoryBudgetSummary['status'] | null;
	/** Other spellings the card's reader meets for it: « Non catégorisé » for `uncategorized`. */
	aliases: string[];
}

export interface Grounding {
	/** The period's top categories: the ones whose figure the card can show. */
	categories: GroundingCategory[];
	/** The request the model received, cleaned like a statement, for the echo rule. */
	request: string;
}

const ZWNJ = String.fromCodePoint(0x200c);
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

/**
 * The text the card shows. NFKC folds fullwidth letters and digits; every invisible character goes
 * (direction overrides and isolates, zero-width spaces and joiners, variation selectors, the
 * combining grapheme joiner), except a ZWNJ between two letters, which Persian spelling needs; a
 * control character becomes a space; then the markdown goes and the spacing collapses.
 */
export function cleanShownText(value: string): string {
	const characters = [...value.normalize('NFKC')];
	let kept = '';
	characters.forEach((character, index) => {
		if (INVISIBLE.test(character)) {
			const between =
				LETTER_OR_MARK.test(characters[index - 1] ?? '') &&
				LETTER_OR_MARK.test(characters[index + 1] ?? '');
			if (character === ZWNJ && between) kept += character;
			return;
		}
		kept += /\p{Cc}/u.test(character) && character !== '\n' ? ' ' : character;
	});
	return stripMarkdown(kept).replace(/\s+/gu, ' ').trim();
}

/**
 * What every rule reads: the shown text through the app's one name folding (`normalizeForMatch`:
 * accents stripped, then lowercased, so « MİLLE » reads « mille »), with no ZWNJ left to split a word.
 */
export function analysisText(shown: string): string {
	return normalizeForMatch(shown).replaceAll(ZWNJ, '');
}

/**
 * THE CHARACTERS A STATEMENT MAY USE, as a closed list: deny by default, one level below the
 * numbers. The letters of the languages the card speaks (`cardLanguages.ts`), the punctuation of a
 * sentence, and every character of the member's own top-five category names, so a name in Persian
 * or Devanagari can still be named. Anything else drops the statement: a digit drawn as a letter, a
 * Han numeral, an emoji, a look-alike letter, a stray combining mark, markup, a currency sign (no
 * amount may be written, so a currency sign has no honest use).
 */
const LANGUAGES = Object.values(CARD_LANGUAGES);
const LETTERS = new Set(LANGUAGES.flatMap((language) => [...language.letters]));
const SENTENCE_PUNCTUATION = new Set([
	...` .,;:!?'"()-/&`,
	...[0x2018, 0x2019, 0x201c, 0x201d, 0xab, 0xbb, 0x2010, 0x2013, 0x2014, 0x2026].map((point) =>
		String.fromCodePoint(point)
	)
]);

/** Any numeric character, in any script, that NFKC left: digits, Tamil or Ethiopic numbers. */
const NUMERIC = /\p{N}/u;
/** Words, for the word-by-word checks: anything that is not a letter or a mark separates them. */
const WORD_SEPARATOR = /[^\p{L}\p{M}]+/u;
const NUMBER_ROOTS = [...new Set(LANGUAGES.flatMap((language) => language.numberRoots))];
const QUANTITY_WORDS = LANGUAGES.flatMap((language) => language.quantityWords);
const QUANTITY_ENDINGS = LANGUAGES.flatMap((language) => language.quantityEndings);
/** Endings that keep a number word a number: « tenfold », « tenth », « hundredths ». */
const NUMBER_SUFFIXES = ['fold', 'ths', 'th'];

/** Whether `word` is one or more number roots written together: « fortyfive », « dixsept ». */
function composesFromRoots(word: string): boolean {
	const reached = Array.from({ length: word.length + 1 }, (_, index) => index === 0);
	for (let index = 0; index < word.length; index += 1) {
		if (!reached[index]) continue;
		for (const root of NUMBER_ROOTS) {
			if (word.startsWith(root, index)) reached[index + root.length] = true;
		}
	}
	return reached[word.length];
}

/** A number word: roots written together, then an optional plural, then an optional suffix. */
function isNumberWord(word: string): boolean {
	const stems = [
		word,
		...NUMBER_SUFFIXES.filter((suffix) => word.length > suffix.length && word.endsWith(suffix)).map(
			(suffix) => word.slice(0, -suffix.length)
		)
	];
	return stems.some(
		(stem) =>
			composesFromRoots(stem) || (stem.endsWith('s') && composesFromRoots(stem.slice(0, -1)))
	);
}

/**
 * Whether the text states a quantity in words, in any language the card speaks: a number word, a
 * listed quantity word or phrase, a word with a quantity ending. « One » and « un » are not roots:
 * they are also articles, and « one of your smaller lines » is a ruled must-show. « First » and
 * « second » are ranks.
 */
function statesQuantityInWords(text: string): boolean {
	const words = text.split(WORD_SEPARATOR).filter((word) => word !== '');
	const padded = ` ${words.join(' ')} `;
	return (
		words.some(isNumberWord) ||
		QUANTITY_WORDS.some((quantity) => padded.includes(` ${quantity} `)) ||
		words.some((word) =>
			QUANTITY_ENDINGS.some((ending) => word.length > ending.length && word.endsWith(ending))
		)
	);
}

/**
 * Upper-case runs of the letters that read as digits or as a Roman numeral, as written: « IOO »
 * reads as 100 in a sans-serif font, « XII » as 12.
 */
const DIGIT_SHAPED = /(?<![\p{L}\p{M}])[IOVXLCDM]{2,}(?![\p{L}\p{M}])/u;

/** Whether the statement states a quantity: a numeric character, a quantity word, a digit shape. */
function statesQuantity(shown: string, text: string): boolean {
	return (
		NUMERIC.test(text) ||
		text.includes('%') ||
		statesQuantityInWords(text) ||
		DIGIT_SHAPED.test(shown)
	);
}

/** Whether every character of the shown statement is on the list above. */
function usesOnlyAllowed(shown: string, nameCharacters: Set<string>): boolean {
	return [...shown].every(
		(character) =>
			LETTERS.has(character) || SENTENCE_PUNCTUATION.has(character) || nameCharacters.has(character)
	);
}

/**
 * The categories a text names, as keys: lowered cleaned names, longest first, whole words only,
 * never overlapping.
 */
function mentionsIn(text: string, keys: string[]): Set<string> {
	const spans: { start: number; end: number; key: string }[] = [];
	for (const key of keys) {
		for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
			const end = at + key.length;
			if (WORD_CHARACTER.test(text[at - 1] ?? '') || WORD_CHARACTER.test(text[end] ?? '')) continue;
			if (spans.some((other) => at < other.end && other.start < end)) continue;
			spans.push({ start: at, end, key });
		}
	}
	return new Set(spans.map((span) => span.key));
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * The statements the card may show, each with the figures of the categories it names and a
 * severity taken from their budget status. Every statement dropped: `response_withheld`.
 */
export function acceptAdvice(advice: LocalAiAdvice, grounding: Grounding): LocalAiAdvice {
	if (advice.unavailable || advice.insights.length === 0) return advice;

	// Every spelling of every top category, as a key. A key two categories share names neither.
	const byKey = new Map<string, Set<GroundingCategory>>();
	for (const category of grounding.categories) {
		for (const spelling of [category.name, ...category.aliases]) {
			const key = analysisText(cleanShownText(spelling));
			// A name cleaned to nothing (only invisible characters) names nothing, and an empty key
			// would never leave the search loop below.
			if (key === '') continue;
			byKey.set(key, (byKey.get(key) ?? new Set()).add(category));
		}
	}
	// Longest first, so « rent extras » is one mention and not « rent ».
	const keys = [...byKey.keys()].sort((left, right) => right.length - left.length);
	const nameCharacters = new Set(
		grounding.categories.flatMap((category) =>
			[category.name, ...category.aliases].flatMap((spelling) => [...cleanShownText(spelling)])
		)
	);

	const kept: BudgetInsight[] = [];
	for (const insight of advice.insights) {
		const title = cleanShownText(insight.title);
		const message = cleanShownText(insight.message);
		if (title === '' && message === '') continue;
		// Title and message as ONE text: « Index funds » over « Buy one every month » is one advice.
		const shown = `${title} ${message}`;
		if (!usesOnlyAllowed(shown, nameCharacters)) continue;
		const text = analysisText(shown);
		if (statesQuantity(shown, text)) continue;
		if (policyBreach(text, grounding.request) !== null) continue;

		const named = mentionsIn(text, keys);
		// In payload order, once each, and only where a name says which category it is.
		const attached = grounding.categories.filter((category) =>
			[...named].some((key) => {
				const owners = byKey.get(key)!;
				return owners.size === 1 && owners.has(category);
			})
		);
		const severity = attached.reduce<InsightSeverity>((worst, category) => {
			const candidate = severityForBudgetStatus(category.status);
			return SEVERITY_RANK[candidate] > SEVERITY_RANK[worst] ? candidate : worst;
		}, 'info');

		kept.push({
			...insight,
			title,
			message,
			severity,
			figures: attached.map((category) => ({
				category: cleanShownText(category.name),
				amountCents: category.amountCents
			}))
		});
	}

	if (kept.length === 0)
		return { insights: [], unavailable: true, failureCode: 'response_withheld' };
	return { ...advice, insights: kept };
}

/** The join between a payload category and its budget, through the app's one name folding. */
export function budgetStatusOf(
	name: string,
	summaries: Pick<CategoryBudgetSummary, 'category' | 'status'>[]
): CategoryBudgetSummary['status'] | null {
	const key = normalizeForMatch(name);
	return summaries.find((summary) => normalizeForMatch(summary.category) === key)?.status ?? null;
}
