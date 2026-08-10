import {
	matchesBanquePopulaireHeader,
	parseBanquePopulaireRows
} from './profiles/banque-populaire';
import { matchesGenericHeader, parseGenericRows } from './profiles/generic';
import { matchesMaisonHeader, parseMaisonRows } from './profiles/maison';
import { matchesMaisonV2Header, parseMaisonV2Rows } from './profiles/maison-v2';
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
	// TWO parsers share the `maison` name, and that is the versioning: v2 recognises the header the
	// export writes today, v1 the seven-column header a user's older file still carries. Neither
	// matches the other's shape (both check an exact column count), so order between them is a
	// preference rather than a hazard — but both must sit before `generic`, whose match is loose.
	{
		profile: 'maison',
		matches: matchesMaisonV2Header,
		parse: parseMaisonV2Rows
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

	// The match is part of the lookup, not a check applied after it: a profile can be served by more
	// than one parser (see `maison` above), and finding the first parser NAMED `maison` and then
	// asking whether it matches would answer `null` for a v2 file whenever v1 happened to be first.
	return (
		csvProfileParsers.find(
			(candidate) =>
				candidate.profile === (profile as ResolvedCsvImportProfile) && candidate.matches(headers)
		) ?? null
	);
}
