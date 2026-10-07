import { z } from 'zod';
import { OperatorFacingError } from '$lib/server/operatorFacingError';
import { readOperatorBound, reportBoundDeparture } from './operatorBound';
import { SETTINGS, type IntegerSettingName, type SettingName } from './settings';

/**
 * THE ONE READING OF A WHOLE-NUMBER SETTING, with its range taken from the registry (R14, #754).
 *
 * Two steps, each with one owner. `readOperatorBound` decides the SPELLING (digits 0 to 9 only,
 * blank means unset, never `0x10` or `1e3`), and stays the single place that rule lives. This
 * decides the RANGE: below `min` or above `max` is refused at boot, never clamped and never replaced
 * by the default, so the value in force is always the value the operator wrote (AGENTS.md, « Code
 * style »).
 *
 * The refusal names the variable, the value written, the accepted range, why the ceiling sits
 * where it does, the default, and the two ways out. Never a secret: no integer setting is one.
 */
export function readIntegerSetting(
	name: IntegerSettingName,
	source: NodeJS.ProcessEnv = process.env
): number {
	const setting = SETTINGS[name];
	const value = readOperatorBound(
		{ name, fallback: setting.default, purpose: setting.summary },
		source
	);
	const range = z.number().int().min(setting.min).max(setting.max);
	if (range.safeParse(value).success) return value;

	const side =
		value > setting.max
			? `above the ceiling of ${setting.max}. ${setting.ceiling}`
			: `below the minimum of ${setting.min}.`;
	throw new OperatorFacingError(
		`${name}=${value} is ${side} Accepted: ${setting.min} to ${setting.max} ${setting.unit}. ` +
			`The default is ${setting.default}: remove the line to use it, or write a value in that range. ` +
			'The value is refused rather than adjusted, so the setting in force is always the one you wrote.'
	);
}

/** Every choice whose unknown values are refused rather than read as the default. */
type RefusedChoiceName = {
	[K in SettingName]: (typeof SETTINGS)[K] extends { kind: 'choice'; otherwise: 'refused' }
		? K
		: never;
}[SettingName];

/**
 * THE ONE READING OF A CHOICE whose registry entry says an unknown value is `refused`. Blank and
 * unset are the default; surrounding whitespace is trimmed; the comparison is exact, so `On` is
 * refused rather than guessed. The message lists the accepted values and the default.
 */
export function readChoiceSetting(
	name: RefusedChoiceName,
	source: NodeJS.ProcessEnv = process.env
): string {
	const setting = SETTINGS[name];
	const written = source[name]?.trim();
	if (!written) return setting.default;
	if (z.enum(setting.values).safeParse(written).success) return written;
	throw new OperatorFacingError(
		`${name} must be one of ${setting.values.join(', ')} (got ${JSON.stringify(source[name])}). ${setting.summary} The default is ${setting.default}.`
	);
}

/**
 * A boot check for one whole-number setting: refuse an unreadable or out-of-range value, and warn
 * when the value differs from the default. Not exported, so the naming rule in
 * `assertConfigured.spec.ts` sees only the named checks below, each registered once.
 */
function checkIntegerSetting(name: IntegerSettingName): void {
	const value = readIntegerSetting(name);
	reportBoundDeparture(name, value, SETTINGS[name].default, false);
}

// The six settings #754 found reading `Number()` or `parseInt()` and falling back or clamping. Each
// is registered in `ENVIRONMENT_CHECKS`, which makes the spelling probe in `assertConfigured.spec.ts`
// hold it to the same fourteen spellings as the five older bounds.
export function assertPasswordHashCostConfigured(): void {
	checkIntegerSetting('PASSWORD_HASH_COST');
}
export function assertSessionLifetimeConfigured(): void {
	checkIntegerSetting('SESSION_TTL_DAYS');
}
export function assertInvitationLifetimeConfigured(): void {
	checkIntegerSetting('INVITATION_TTL_HOURS');
}
export function assertBankSyncLookbackConfigured(): void {
	checkIntegerSetting('BANK_SYNC_FIRST_LOOKBACK_DAYS');
}
export function assertLlmTimeoutConfigured(): void {
	checkIntegerSetting('LLM_TIMEOUT_MS');
}
export function assertLlmConnectTimeoutConfigured(): void {
	checkIntegerSetting('LLM_CONNECT_TIMEOUT_MS');
}

// Added with the setting itself (#221), so it never had a lenient reading to replace.
export function assertSessionIdleTimeoutConfigured(): void {
	checkIntegerSetting('BP_SESSION_IDLE_TIMEOUT_HOURS');
}
