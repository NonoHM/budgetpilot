/**
 * Reading a model's raw answer for `npm run ai:check` (#971). INSTRUMENTS for the report, not the
 * rules G3 ships: they answer « how often does this model write a figure its data does not hold ».
 */

/** Unicode allocates decimal digits as runs of ten from zero, so a digit's value is its place. */
function asciiDigits(text: string): string {
	return text.replace(/\p{Nd}/gu, (c) => {
		const code = c.codePointAt(0)!;
		let low = code;
		while (/\p{Nd}/u.test(String.fromCodePoint(low - 1))) low -= 1;
		return String((code - low) % 10);
	});
}

/**
 * Every numeral in `text` as a number, whatever its script: NFKC first (fullwidth and mathematical
 * digits), then any other digit by its value, so `١٤٥\u066b٣٠` reads 145.3. A thousands separator (a
 * comma or a space before exactly three digits) is removed first, so `2,100.00` and `1 008,30` read
 * 2100 and 1008.3 rather than two numbers each; a comma before two digits stays a decimal comma.
 */
export function numeralsIn(text: string): number[] {
	const digits = asciiDigits(text.normalize('NFKC')).replace(
		/(\d)[,\u00a0\u202f ](?=\d{3}(?!\d))/g,
		'$1'
	);
	return [...digits.matchAll(/\d+(?:[.,\u066b]\d+)?/g)].map((match) =>
		Number(match[0].replace(/[,\u066b]/, '.'))
	);
}
