import {
	matchesBanquePopulaireHeader,
	parseBanquePopulaireRows
} from './profiles/banque-populaire';
import { matchesGenericHeader, parseGenericRows } from './profiles/generic';
import { matchesMaisonHeader, parseMaisonRows } from './profiles/maison';
import { matchesRevolutHeader, parseRevolutRows } from './profiles/revolut';
import type { CsvImportProfile, CsvProfileParser, ResolvedCsvImportProfile } from './types';

export const csvProfileParsers: CsvProfileParser[] = [
	{
		profile: 'banque-populaire',
		matches: matchesBanquePopulaireHeader,
		parse: parseBanquePopulaireRows
	},
	{
		profile: 'revolut',
		matches: matchesRevolutHeader,
		parse: parseRevolutRows
	},
	{
		profile: 'maison',
		matches: matchesMaisonHeader,
		parse: parseMaisonRows
	},
	{
		profile: 'generic',
		matches: matchesGenericHeader,
		parse: parseGenericRows
	}
];

export function resolveProfile(
	headers: string[],
	profile: CsvImportProfile
): CsvProfileParser | null {
	if (profile === 'auto') {
		return csvProfileParsers.find((parser) => parser.matches(headers)) ?? null;
	}

	const parser = csvProfileParsers.find(
		(candidate) => candidate.profile === (profile as ResolvedCsvImportProfile)
	);
	if (!parser) return null;
	return parser.matches(headers) ? parser : null;
}
