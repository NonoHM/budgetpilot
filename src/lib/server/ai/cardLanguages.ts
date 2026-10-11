import type { ResponseLocale } from '$lib/server/insights/prompt';

/**
 * WHAT A STATEMENT ON THE AI CARD MAY BE WRITTEN WITH, per language the card speaks (G3, #969).
 *
 * One entry per language the prompt can answer in, and the type is the enforcement: the table
 * `satisfies Record<ResponseLocale, CardLanguage>`, so adding a language to `RESPONSE_LANGUAGES`
 * in `insights/prompt.ts` without its entry here stops `npm run check`. Without that, a third
 * language would reach the card with its number words unread, which is the failure that is silent.
 *
 * Both lists are CLOSED SETS, deny by default (the owner's ruling, 2026-10-11): a character not in
 * `letters` drops the statement, and so does any word built from `numberRoots` or listed in
 * `quantityWords`. The alphabet is the language's own, not « the Latin script »: that script also
 * holds letters drawn like digits (U+01BC looks like 5) and letters that break a word without
 * changing how it reads (a dotless i), which a contradiction pass found one by one.
 *
 * Words are written folded, the way `normalizeForMatch` leaves the text they are matched against:
 * no accents, lower case.
 */
export interface CardLanguage {
	/** Every letter a statement may use, in both cases. Nothing else of the script. */
	letters: string;
	/**
	 * Roots every cardinal is built from. They compose (« fortyfive », « dixsept »), take a plural
	 * and the suffixes `fold`, `th` and `ieth`, so a word made of them states a number.
	 */
	numberRoots: string[];
	/** Whole words that state a quantity, a ratio, a fraction or a currency. */
	quantityWords: string[];
	/** Patterns over a whole word, for a class of words the language marks by its ending. */
	quantityEndings: string[];
}

const ASCII_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const CARD_LANGUAGES = {
	en: {
		letters: ASCII_LETTERS,
		numberRoots: [
			'zero',
			'two',
			'three',
			'four',
			'five',
			'six',
			'seven',
			'eight',
			'nine',
			'ten',
			'eleven',
			'twelve',
			'thirteen',
			'fourteen',
			'fifteen',
			'sixteen',
			'seventeen',
			'eighteen',
			'nineteen',
			'twenty',
			'thirty',
			'forty',
			'fifty',
			'sixty',
			'seventy',
			'eighty',
			'ninety',
			'hundred',
			'thousand',
			'million',
			'billion',
			'trillion',
			'dozen'
		],
		quantityWords: [
			'half',
			'halves',
			'twice',
			'thrice',
			'quarters?',
			'doubled?',
			'doubles',
			'tripled?',
			'triples',
			'quadrupled?',
			'quintupled?',
			'percent',
			'per cent',
			'thirds?',
			'fifths?',
			'eighths?',
			'ninths?',
			'twelfths?',
			'twentieths?',
			'thirtieths?',
			'fortieths?',
			'fiftieths?',
			'sixtieths?',
			'seventieths?',
			'eightieths?',
			'ninetieths?',
			'euros?',
			'eur',
			'cents?',
			'dollars?',
			'pounds?',
			'usd',
			'gbp',
			'chf'
		],
		quantityEndings: []
	},
	fr: {
		letters: `${ASCII_LETTERS}àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ`,
		numberRoots: [
			'deux',
			'trois',
			'quatre',
			'cinq',
			'six',
			'sept',
			'huit',
			'neuf',
			'dix',
			'onze',
			'douze',
			'treize',
			'quatorze',
			'quinze',
			'seize',
			'vingt',
			'trente',
			'quarante',
			'cinquante',
			'soixante',
			'septante',
			'octante',
			'huitante',
			'nonante',
			'cent',
			'mille',
			'millier',
			'million',
			'milliard',
			'dizaine',
			'douzaine',
			'centaine'
		],
		quantityWords: [
			'moitie',
			'demi',
			'quarts?',
			'tiers',
			'double',
			'triple',
			'pour ?cent',
			'pourcent',
			'centimes?',
			'euros?',
			'francs?'
		],
		// Every ordinal after « second » ends in « ième »: « deuxième », « dixième », « énième ».
		quantityEndings: ['\\p{L}*iemes?']
	}
} satisfies Record<ResponseLocale, CardLanguage>;
