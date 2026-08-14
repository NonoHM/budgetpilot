import { prisma } from '$lib/server/db';
import { candidateFingerprints } from './fingerprint';
import {
	boundedColumnName,
	validateColumnMapping,
	type ColumnMappingInput,
	type ColumnMappingRefusal
} from './model';

/**
 * The most column mappings one user may hold.
 *
 * Every distinct header shape a user uploads creates a row and nothing deletes one, so an upload
 * loop of files differing by one character in one header would otherwise create unlimited rows. A
 * minimal valid CSV is a few dozen bytes against a 256 000 byte cap, and there is no rate limit on
 * the import route.
 *
 * **Refused rather than evicted.** Silently dropping the oldest mapping means a user's regular
 * bank stops being recognised because they once imported twenty odd files, which is the same
 * silent failure one level up from the one this prevents.
 *
 * 50 against a realistic ceiling of about fifteen: five banks, three format changes each.
 *
 * **THE ESCAPE HATCH IS OWED AND IS NOT HERE YET.** A cap with no way to free a row is a permanent
 * block, and a refusal that tells someone they can never import a new bank again, with no next
 * step, is worse than the cap it enforces. Until #326 ships a removal list on the settings page,
 * the refusal message says one is coming and names that issue. **Do not raise this number instead
 * of building that screen.**
 */
export const COLUMN_MAPPINGS_PER_USER_DEFAULT = 50;

/** Above this the cap stops being a cap: see #326 for what has to exist before it is raised. */
export const COLUMN_MAPPINGS_PER_USER_CEILING = 500;

export const COLUMN_MAPPINGS_PER_USER_ENV = 'COLUMN_MAPPINGS_PER_USER';

/**
 * Reads the configured cap, or throws. Same contract as `resolveBackupMaxJsonNodes` and
 * `resolveCsvMaxColumns`: read per call, refused rather than clamped above the ceiling, so that a
 * bound you set is the bound that runs.
 */
export function resolveColumnMappingsPerUser(): number {
	const raw = process.env[COLUMN_MAPPINGS_PER_USER_ENV];
	if (raw === undefined || raw.trim() === '') return COLUMN_MAPPINGS_PER_USER_DEFAULT;

	const cap = Number(raw);
	if (!Number.isInteger(cap) || cap < 1) {
		throw new Error(
			`${COLUMN_MAPPINGS_PER_USER_ENV} must be a whole number of at least 1 (got ${JSON.stringify(raw)}). It bounds how many remembered column mappings one user may hold. The default is ${COLUMN_MAPPINGS_PER_USER_DEFAULT}.`
		);
	}

	if (cap > COLUMN_MAPPINGS_PER_USER_CEILING) {
		throw new Error(
			`${COLUMN_MAPPINGS_PER_USER_ENV}=${cap} is above the hard ceiling of ${COLUMN_MAPPINGS_PER_USER_CEILING}. Nothing deletes a column mapping yet, so this cap is the only thing bounding a table one upload can grow. The value is refused rather than clamped so that a bound you set is the bound that runs. See issue #326.`
		);
	}

	return cap;
}

/**
 * Boot check, called from `hooks.server.ts` beside the other two bounds. Refuses to start on an
 * out-of-range value, and reports any departure from the default.
 *
 * At boot rather than on first use, which is where `resolveColumnMappingsPerUser` would otherwise
 * surface it: an operator typo would then appear as one user's import failing, months later, with
 * a message about a limit rather than about their configuration.
 */
export function assertColumnMappingCapConfigured(): void {
	const cap = resolveColumnMappingsPerUser();
	if (cap === COLUMN_MAPPINGS_PER_USER_DEFAULT) return;

	console.warn(
		`[budgetpilot] ${COLUMN_MAPPINGS_PER_USER_ENV}=${cap} differs from the default of ${COLUMN_MAPPINGS_PER_USER_DEFAULT}. It bounds how many remembered column mappings one user may hold.`
	);

	if (cap > COLUMN_MAPPINGS_PER_USER_DEFAULT) {
		console.warn(
			`[budgetpilot] ${COLUMN_MAPPINGS_PER_USER_ENV} is RAISED above the default, and nothing deletes a column mapping yet (issue #326), so this cap is the only thing bounding a table one upload can grow.`
		);
	}
}

export type SaveColumnMappingResult =
	| { ok: true; id: string }
	| { ok: false; reason: ColumnMappingRefusal | { code: 'cap-reached'; max: number } };

/**
 * The mapping remembered for this file's header shape, or null.
 *
 * ALWAYS scoped by `userId`, and both candidate fingerprints are looked up in one query because
 * the caller does not yet know whether the remembered mapping matched by name or by position. A
 * fingerprint is derived from a bank's PUBLIC column names, so every user of that bank shares one:
 * a lookup without `userId` would read another user's configuration, and that is not a rare
 * collision but the designed behaviour of the key.
 */
export async function readColumnMapping(userId: string, headers: string[]) {
	const [byName, byPosition] = candidateFingerprints(headers);
	return prisma.columnMapping.findFirst({
		where: { userId, fingerprint: { in: [byName, byPosition] } }
	});
}

export async function countColumnMappings(userId: string): Promise<number> {
	return prisma.columnMapping.count({ where: { userId } });
}

/**
 * Writes a mapping, or refuses with a reason.
 *
 * Every column name goes through `boundedColumnName` HERE rather than at the caller, so no write
 * path can store an unbounded cell from a user's file. The validator runs here for the same
 * reason: this and `assertReferentialIntegrity` are the two write paths, and they share one
 * predicate rather than two that agree today.
 */
export async function saveColumnMapping(
	userId: string,
	fingerprint: string,
	input: ColumnMappingInput
): Promise<SaveColumnMappingResult> {
	const bounded: ColumnMappingInput = {
		...input,
		dateColumn: input.dateColumn === null ? null : boundedColumnName(input.dateColumn),
		labelColumn: input.labelColumn === null ? null : boundedColumnName(input.labelColumn),
		amountColumn: input.amountColumn === null ? null : boundedColumnName(input.amountColumn),
		categoryColumn: input.categoryColumn === null ? null : boundedColumnName(input.categoryColumn)
	};

	const verdict = validateColumnMapping(bounded);
	if (!verdict.ok) return { ok: false, reason: verdict.reason };

	// Counted BEFORE the write and only when this fingerprint is new: replacing a mapping the user
	// already has must never be refused for being one too many, or correcting a designation would
	// become impossible at exactly the moment the cap is reached.
	const existing = await prisma.columnMapping.findUnique({
		where: { userId_fingerprint: { userId, fingerprint } },
		select: { id: true }
	});
	if (!existing) {
		const max = resolveColumnMappingsPerUser();
		if ((await countColumnMappings(userId)) >= max) {
			return { ok: false, reason: { code: 'cap-reached', max } };
		}
	}

	const saved = await prisma.columnMapping.upsert({
		where: { userId_fingerprint: { userId, fingerprint } },
		update: { ...bounded },
		create: { userId, fingerprint, ...bounded },
		select: { id: true }
	});
	return { ok: true, id: saved.id };
}

/** Records that a mapping was used, for the recap sentence. Scoped, like every other read here. */
export async function recordColumnMappingUse(userId: string, id: string): Promise<void> {
	await prisma.columnMapping.updateMany({
		where: { id, userId },
		data: { useCount: { increment: 1 }, lastUsedAt: new Date() }
	});
}
