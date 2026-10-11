/**
 * The output policy (G3, #969): what a statement of the model may not say, whatever the payload
 * holds. AISVS 1.0 C7.3.1 for the categories defined here, C11.2.1 for `article9`, C7.3.2 for `echo`.
 *
 * PHRASE-SHAPED, NEVER A WORD ALONE, and with no exemption for a term the payload contains (spec F3).
 * « Insurance » is an ordinary category name; « take out an insurance » is a product recommendation.
 * A word list would drop the first, and an exemption for payload terms would admit the second
 * whenever the member has a category of that name.
 *
 * Every pattern reads text that `accept.ts` has already cleaned and folded: NFKC, no invisible
 * character, no markdown, one space between words, accents stripped and lowercased the way
 * `normalizeForMatch` does it (the patterns are folded the same way). That is what makes a short list
 * hold: the spellings an attacker would use to slip past it (`id**iot**`, a zero-width joiner inside a
 * word, a fullwidth letter, a Cyrillic letter that looks Latin) are gone or refused before it runs.
 * What remains is the shape of any list of phrasings: a paraphrase passes. #996 is the allow-list.
 *
 * A pure function of its input, so a rule has a must-fire and a must-not-fire twin in the corpus.
 */

export type PolicyRule = 'regulated' | 'article9' | 'abusive' | 'echo' | 'url-email';

/*
 * REGEX LITERALS, NEVER BUILT FROM A STRING (ASVS v5.0.0-1.2.9, held by `injection-sinks.spec.ts`).
 * Each is one list of alternatives, written already folded the way `normalizeForMatch` folds the
 * text (no accents, lower case), each alternative a whole word: no letter, mark or digit on either
 * side, because `\b` is ASCII-only and the text is not.
 */

/**
 * (a) A recommendation to acquire a regulated financial product: an acquisition verb and a product
 * in the same sentence, in either order (« put your savings in an index fund », « an index fund is
 * the place to put them »). Investment, credit and insurance advice is what the system prompt
 * forbids and what a budgeting card must not give (MiFID II, the Consumer Credit Directive and the
 * Insurance Distribution Directive each regulate it).
 */
const ACQUIRE =
	/(?<![\p{L}\p{M}\p{N}])(?:invest(?:ing|s)?|consider(?:ing)?|put(?:ting)?|buy(?:ing|s)?|purchas(?:e|ing)|open(?:ing)?|subscrib(?:e|ing)|take out|sign up|apply for|switch to|get|investi\p{L}*|plac(?:ez|er)|achet\p{L}*|ouvr(?:ez|ir)|souscri\p{L}*|contract(?:ez|er)|pren(?:ez|dre)|emprunt(?:ez|er)|opt(?:ez|er))(?![\p{L}\p{M}\p{N}])/u;
const PRODUCT =
	/(?<![\p{L}\p{M}\p{N}])(?:etfs?|index funds?|mutual funds?|funds?|stocks?|equit(?:y|ies)|bonds?|crypto\p{L}*|bitcoins?|ethereum|loans?|credit(?: cards?)?|mortgages?|(?:life )?insurances?|annuit(?:y|ies)|pension plans?|fonds|actions en bourse|bourse|obligations?|pea|scpi|assurances?(?:[- ]vie)?|credits?|prets?|placements?)(?![\p{L}\p{M}\p{N}])/u;

/**
 * (b) An inference about the person in a GDPR Article 9 category: health, pregnancy, religion,
 * sexual orientation, political opinion, union membership, ethnic origin. Shaped as a state
 * ATTRIBUTED to « you », so « Health is a small part of your spending » stays while « your Health
 * spending suggests you may be ill » goes.
 */
const ATTRIBUTION =
	/(?<![\p{L}\p{M}\p{N}])(?:you(?:'re| are| were| may be| might be| could be| must be| seem(?: to be)?| appear(?: to be)?| have| suffer from| practi[cs]e| belong to| vote)|your (?:health condition|illness|pregnancy|religion|faith|sexual orientation|sexuality|politics|ethnicity|diagnosis)|vous (?:etes|etes|etiez|semblez|paraissez|pourriez etre|devez etre|avez|souffrez|pratiquez|votez)|tu es|votre (?:maladie|grossesse|religion|foi|orientation|sexualite|origine))(?![\p{L}\p{M}\p{N}])/u;
const SPECIAL_CATEGORY =
	/(?<![\p{L}\p{M}\p{N}])(?:ill|sick|unwell|pregnant|expecting a (?:baby|child)|diabet\p{L}*|depress\p{L}*|cancer|disab\p{L}*|illness|disease|addict\p{L}*|alcoholic|hiv|catholic|muslim|jewish|christian|protestant|buddhist|hindu|religious|practi[cs]ing|believer|atheist|gay|lesbian|bisexual|homosexual|transgender|queer|left-wing|right-wing|communist|socialist|union member|unioni[sz]ed|ethnic\p{L}*|immigrant|malade|enceinte|diabetique|depressi\p{L}*|deprimee?|handicap\p{L}*|alcoolique|seropositi\p{L}*|catholique|musulman\p{L}*|juif|juive|chretien\p{L}*|bouddhiste|hindou\p{L}*|religieu\p{L}*|pratiquant\p{L}*|croyant\p{L}*|athee|homosexuel\p{L}*|lesbienne|bisexuel\p{L}*|transgenre|syndique\p{L}*|communiste|socialiste|immigre\p{L}*)(?![\p{L}\p{M}\p{N}])/u;

/**
 * (d) Abuse. The hostile model of attacker 2 writes whatever it likes, and nothing else screens this
 * side. A small lexicon on purpose: « nul » is absent because it also means zero in French.
 */
const ABUSIVE =
	/(?<![\p{L}\p{M}\p{N}])(?:idiot\p{L}*|stupid\p{L}*|moron\p{L}*|dumb\p{L}*|loser\p{L}*|pathetic|worthless|imbecile\p{L}*|cretin\p{L}*|fuck\p{L}*|shit\p{L}*|bitch\p{L}*|bastard\p{L}*|cretin\p{L}*|imbecile\p{L}*|abruti\p{L}*|debile\p{L}*|connard\p{L}*|connasse\p{L}*|conne|salaud\p{L}*|salope\p{L}*|merde\p{L}*|putain\p{L}*)(?![\p{L}\p{M}\p{N}])/u;

/** A link or an address: a scheme, `www.`, an e-mail, or a bare domain under a common TLD. */
const URL_OR_EMAIL =
	/[a-z][a-z0-9+.-]*:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|(?<![\p{L}\p{N}@.])[\p{L}\p{N}-]+\.(?:com|net|org|fr|io|co|eu|info|biz|be|ch|de|uk|app|dev|xyz|me|ai|ly|gg|tv|us|ca|es|it|nl)(?![\p{L}\p{N}])/u;

/** (c) Forty characters or more of the request repeated back: the system prompt, or the payload. */
export const ECHO_WINDOW = 40;

/**
 * A sentence ends at `. ! ?` followed by a space or the end, so `145.30` stays whole. Not at `:` or
 * `;`: « ETF : achetez-en chaque mois » is one recommendation, and a split would hide it.
 */
export function sentencesOf(text: string): string[] {
	return text.split(/(?<=[.!?])(?= |$)/u).filter((sentence) => sentence.trim() !== '');
}

/**
 * The first rule the statement breaks, or null. `lowered` is the shown text, lowercased, ZWNJ
 * removed; `request` is the request the model received, cleaned the same way.
 */
export function policyBreach(lowered: string, request: string): PolicyRule | null {
	const sentences = sentencesOf(lowered);
	const both = (left: RegExp, right: RegExp) => (sentence: string) =>
		left.test(sentence) && right.test(sentence);
	if (sentences.some(both(ACQUIRE, PRODUCT))) return 'regulated';
	if (sentences.some(both(ATTRIBUTION, SPECIAL_CATEGORY))) return 'article9';
	if (ABUSIVE.test(lowered)) return 'abusive';
	if (URL_OR_EMAIL.test(lowered)) return 'url-email';
	for (let start = 0; start + ECHO_WINDOW <= lowered.length; start += 1) {
		if (request.includes(lowered.slice(start, start + ECHO_WINDOW))) return 'echo';
	}
	return null;
}
