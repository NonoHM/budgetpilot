const MOJIBAKE_PATTERN = /(?:Ã.|Â.|â[€™“”€¦])/;
const MOJIBAKE_FALLBACKS: Array<[RegExp, string]> = [
	[/Ã©/g, 'é'],
	[/Ã¨/g, 'è'],
	[/Ãª/g, 'ê'],
	[/Ã«/g, 'ë'],
	[/Ã‰/g, 'É'],
	[/Ãˆ/g, 'È'],
	[/Ã /g, 'à'],
	[/Ã¢/g, 'â'],
	[/Ã´/g, 'ô'],
	[/Ã»/g, 'û'],
	[/Ã¹/g, 'ù'],
	[/Ã§/g, 'ç'],
	[/Â /g, ' ']
];

export function normalizeImportedContent(content: string): string {
	return normalizeMojibakeText(content.replace(/^\uFEFF/, ''));
}

export function normalizeHeaderName(value: string): string {
	return normalizeMojibakeText(value).trim().replace(/\s+/g, ' ');
}

export function normalizeMojibakeText(value: string): string {
	if (!MOJIBAKE_PATTERN.test(value)) return value;

	const bytes: number[] = [];
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code > 255) return applyMojibakeFallbacks(value);
		bytes.push(code);
	}

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
	} catch {
		return applyMojibakeFallbacks(value);
	}
}

function applyMojibakeFallbacks(value: string): string {
	return MOJIBAKE_FALLBACKS.reduce(
		(current, [pattern, replacement]) => current.replace(pattern, replacement),
		value
	);
}
