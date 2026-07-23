export function getInitials(label: string): string {
	return label
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? '')
		.join('');
}

export function getEmailInitials(email: string): string {
	const localPart = email.split('@')[0] ?? '';
	const words = localPart.split(/[._-]+/).filter(Boolean);
	if (words.length >= 2) return getInitials(words.join(' '));
	const source = words[0] ?? localPart;
	return source.slice(0, 2).toUpperCase();
}
