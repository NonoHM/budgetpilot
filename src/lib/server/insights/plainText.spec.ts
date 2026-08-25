import { describe, expect, it } from 'vitest';
import { stripMarkdown } from './plainText';

/**
 * The reported instance is « **35%** » reaching the reader with its asterisks. These tests are in
 * two halves, and the second half is the one that decides whether this function is safe to run over
 * every insight: what it must NOT touch.
 *
 * A stripper that damages legitimate text is worse than the markdown it removes, because the
 * markdown is visibly wrong and a mangled merchant name reads as correct.
 */
describe('stripMarkdown', () => {
	describe('removes the markers and keeps the text', () => {
		it.each([
			['**35%**', '35%', 'the reported instance'],
			['*35%*', '35%', 'single asterisk emphasis'],
			['***35%***', '35%', 'bold and italic together'],
			['__important__', 'important', 'doubled underscore'],
			['_important_', 'important', 'single underscore between spaces'],
			['`amountCents`', 'amountCents', 'inline code'],
			[
				'[Carrefour](https://example.test)',
				'Carrefour',
				'a link keeps the label, drops the target'
			],
			['**[Carrefour](https://example.test)**', 'Carrefour', 'a bolded link keeps only the label'],
			['# Vos dépenses', 'Vos dépenses', 'a heading marker'],
			['- Réduisez vos abonnements', 'Réduisez vos abonnements', 'a bullet marker'],
			['> Attention', 'Attention', 'a quote marker']
		])('%s becomes %s (%s)', (input, expected) => {
			expect(stripMarkdown(input)).toBe(expected);
		});

		it('handles a realistic sentence with several markers at once', () => {
			expect(
				stripMarkdown('Vos **dépenses** en _Alimentation_ ont augmenté de `12%` ce mois-ci.')
			).toBe('Vos dépenses en Alimentation ont augmenté de 12% ce mois-ci.');
		});
	});

	describe('leaves text a model legitimately writes exactly as it is', () => {
		it.each([
			['CARREFOUR_MARKET_2', 'an underscore inside a word is not emphasis'],
			['SNCF_CONNECT', 'a single trailing-word underscore pair that is one identifier'],
			['2 * 3 = 6', 'a lone asterisk with spaces around it is not a delimiter'],
			['Vous avez dépensé 35% de votre budget.', 'ordinary prose'],
			['Le solde est de -12,50 EUR.', 'a leading minus inside a sentence'],
			['Économisez 10 % par mois', 'accented text with a percent sign']
		])('%s is unchanged (%s)', (input) => {
			expect(stripMarkdown(input)).toBe(input);
		});

		it('does not prefix an apostrophe onto a sentence opening with a dash, unlike sanitizeImportedText', () => {
			// The reason this is its own function rather than a reuse. `sanitizeImportedText` defuses
			// spreadsheet formula injection by prefixing `'`, which is right for a CSV cell and wrong
			// for a sentence. Separates "we wrote a new helper for no reason" from "the existing one
			// has a different contract".
			expect(stripMarkdown('- 12,50 EUR de moins qu en juin')).not.toContain("'");
		});
	});

	it('is a pure function: the same input gives the same output, and stripping twice changes nothing', () => {
		expect.assertions(2);

		// Idempotence is the property that makes it safe to apply at reception without tracking whether
		// it has already run. Purity is the rule in AGENTS.md for anything whose output is handed on.
		const once = stripMarkdown('Vos **dépenses** en _Alimentation_');
		expect(stripMarkdown(once)).toBe(once);
		expect(stripMarkdown('Vos **dépenses** en _Alimentation_')).toBe(once);
	});
});
