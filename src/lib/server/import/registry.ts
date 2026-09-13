import {
	banquePopulaireDateColumns,
	matchesBanquePopulaireHeader,
	parseBanquePopulaireRows
} from './profiles/banque-populaire';
import { genericDateColumns, matchesGenericHeader, parseGenericRows } from './profiles/generic';
import { maisonDateColumns, matchesMaisonHeader, parseMaisonRows } from './profiles/maison';
import {
	maisonV2DateColumns,
	matchesMaisonV2Header,
	parseMaisonV2Rows
} from './profiles/maison-v2';
import {
	maisonV3DateColumns,
	matchesMaisonV3Header,
	parseMaisonV3Rows
} from './profiles/maison-v3';
import { matchesRevolutHeader, parseRevolutRows, revolutDateColumns } from './profiles/revolut';
import type { CsvImportProfile, CsvProfileParser, ResolvedCsvImportProfile } from './types';

export const csvProfileParsers: CsvProfileParser[] = [
	{
		profile: 'banque-populaire',
		matches: matchesBanquePopulaireHeader,
		dateColumns: banquePopulaireDateColumns,
		parse: parseBanquePopulaireRows
	},
	{
		profile: 'revolut',
		matches: matchesRevolutHeader,
		dateColumns: revolutDateColumns,
		parse: parseRevolutRows
	},
	// THREE parsers share the `maison` name, and that is the versioning: v3 recognises the header
	// the export writes today, v2 the ten-column header it wrote before the account column, v1 the
	// seven-column header a user's older file still carries. No two of them match the same shape
	// (each checks its own constant by exact ordered equality, column count included), so order
	// among them is a preference rather than a hazard, but all three must sit before `generic`,
	// whose match is loose. Newest first, so the list reads in the order a reader asks about it.
	//
	// The names stay `maison` because `CsvImportProfile` has one member for the family and the
	// summary a user sees says « maison ». A per-version profile name would be a wider change than
	// the format needs, and nothing downstream branches on the version.
	{
		profile: 'maison',
		matches: matchesMaisonV3Header,
		dateColumns: maisonV3DateColumns,
		parse: parseMaisonV3Rows
	},
	{
		profile: 'maison',
		matches: matchesMaisonV2Header,
		dateColumns: maisonV2DateColumns,
		parse: parseMaisonV2Rows
	},
	{
		profile: 'maison',
		matches: matchesMaisonHeader,
		dateColumns: maisonDateColumns,
		parse: parseMaisonRows
	},
	{
		profile: 'generic',
		matches: matchesGenericHeader,
		dateColumns: genericDateColumns,
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
