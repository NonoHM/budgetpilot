export function truncateText(value: string, maxLength: number): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}…`;
}

export function anonymizeDetailText(value: string, maxLength = 96): string {
	const normalized = value.trim().replace(/\s+/g, ' ');
	const cardMasked = normalized
		.replace(/\b\d{4,}\s*CB\*+\d+[-\s]*/gi, 'CB****')
		.replace(/\bCB\*+\d+[-\s]*/gi, 'CB****')
		.replace(/\*{2,}\d{2,}[-\s]*/g, '****');
	const referenceMasked = cardMasked.replace(
		/\b(?:REF[A-Z0-9]{3,}|[A-Z0-9]*\d[A-Z0-9]{6,})\b/g,
		(match) => `${match.slice(0, 3)}…`
	);
	const longDigitMasked = referenceMasked.replace(
		/\b\d{8,}\b/g,
		(match) => `${match.slice(0, 4)}…`
	);
	return truncateText(longDigitMasked, maxLength);
}

export function anonymizeReference(value: string): string {
	return value
		.split('|')
		.map((part) => anonymizeDetailText(part))
		.join('|');
}
