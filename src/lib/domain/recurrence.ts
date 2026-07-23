export function normalizeRecurringLabel(label: string): string {
	return label
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\b\d+\b/g, '')
		.replace(/[^a-z]+/g, ' ')
		.trim();
}

export function getAmountTolerance(amountCents: number): number {
	return Math.max(100, Math.round(amountCents * 0.05));
}

export function getSimilarAmountGroups<T extends { amountCents: number }>(
	transactions: T[]
): T[][] {
	const groups: T[][] = [];

	for (const transaction of [...transactions].sort(
		(left, right) => Math.abs(left.amountCents) - Math.abs(right.amountCents)
	)) {
		const amountCents = Math.abs(transaction.amountCents);
		const targetGroup = groups.find((group) => {
			const referenceAmount = Math.abs(group[0].amountCents);
			return Math.abs(referenceAmount - amountCents) <= getAmountTolerance(referenceAmount);
		});

		if (targetGroup) {
			targetGroup.push(transaction);
		} else {
			groups.push([transaction]);
		}
	}

	return groups;
}
