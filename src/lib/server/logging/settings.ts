import { OperatorFacingError } from '../operatorFacingError.ts';

/**
 * The logger's operator settings, in the repository's style for a value an operator may move
 * (AGENTS.md, « Code style »): a closed domain, a default, a refusal rather than a clamp, and a
 * boot warning when the value differs from the default.
 *
 * `BP_LOG_LEVEL` stops at `warn` ON PURPOSE. `sys_startup`, `sys_monitor_disabled`, `sys_crash` and
 * every `budgetpilot.config.*` event are WARN or above (settings.spec.ts enumerates them from the
 * registry), so no value in the domain can silence the line that says how the instance started,
 * or that security logging was turned off, which is how an operator notices that logging stopped.
 *
 * `BP_SECURITY_LOG=off` drops the events the registry marks as security events. It cannot drop the
 * line saying it is off (`sys_monitor_disabled`), which is written at every boot while it is.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

export const LOG_LEVEL_ENV = 'BP_LOG_LEVEL';
export const LOG_LEVELS = ['debug', 'info', 'warn'] as const;
export type LogLevelSetting = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevelSetting = 'info';

export const SECURITY_LOG_ENV = 'BP_SECURITY_LOG';
export const SECURITY_LOG_VALUES = ['on', 'off'] as const;
export type SecurityLogSetting = (typeof SECURITY_LOG_VALUES)[number];
export const DEFAULT_SECURITY_LOG: SecurityLogSetting = 'on';

export const LOG_SEAL_ENV = 'BP_LOG_SEAL';
export const LOG_SEAL_VALUES = ['off', 'on'] as const;
export type LogSealSetting = (typeof LOG_SEAL_VALUES)[number];
export const DEFAULT_LOG_SEAL: LogSealSetting = 'off';

/** Where the key, its verification key and the link state live. The image sets `/data/log-seal`. */
export const LOG_SEAL_DIR_ENV = 'BP_LOG_SEAL_DIR';

/**
 * Seconds between two checkpoints: the window in which the newest lines are not yet sealed.
 * 900 is the default journald ships for its own sealing (`journalctl --interval`). The bounds are
 * here rather than in the settings registry because `boot.mjs` reads them before any bundle exists;
 * the registry imports them.
 */
export const LOG_SEAL_INTERVAL_ENV = 'BP_LOG_SEAL_INTERVAL';
export const DEFAULT_LOG_SEAL_INTERVAL = 900;
export const MIN_LOG_SEAL_INTERVAL = 60;
export const MAX_LOG_SEAL_INTERVAL = 86400;

type Env = Record<string, string | undefined>;

const trimmedValue = (env: Env, name: string): string | undefined => env[name]?.trim();

function readClosed<T extends string>(
	env: Env,
	name: string,
	domain: readonly T[],
	fallback: T
): T | { refused: string } {
	const written = trimmedValue(env, name);
	if (!written) return fallback;
	if ((domain as readonly string[]).includes(written)) return written as T;
	return {
		refused: `${name} must be one of ${domain.join(', ')} (got ${JSON.stringify(env[name])}). The default is ${fallback}.`
	};
}

/** The level in force, or a refusal naming the allowed values. */
export function resolveLogLevel(env: Env): LogLevelSetting {
	const value = readClosed(env, LOG_LEVEL_ENV, LOG_LEVELS, DEFAULT_LOG_LEVEL);
	if (typeof value === 'object') throw new OperatorFacingError(value.refused);
	return value;
}

export function resolveSecurityLog(env: Env): SecurityLogSetting {
	const value = readClosed(env, SECURITY_LOG_ENV, SECURITY_LOG_VALUES, DEFAULT_SECURITY_LOG);
	if (typeof value === 'object') throw new OperatorFacingError(value.refused);
	return value;
}

/**
 * What the startup line reports: each setting as configured, or `refused` when its value is outside
 * the domain. Never the default a refused value falls back to, which would describe a setting
 * nobody chose in the line written just before the boot check refuses to start on it.
 */
export function describeLogSettings(env: Env): {
	level: LogLevelSetting | 'refused';
	securityLog: SecurityLogSetting | 'refused';
	logSeal: LogSealSetting | 'refused';
} {
	const level = readClosed(env, LOG_LEVEL_ENV, LOG_LEVELS, DEFAULT_LOG_LEVEL);
	const securityLog = readClosed(env, SECURITY_LOG_ENV, SECURITY_LOG_VALUES, DEFAULT_SECURITY_LOG);
	const logSeal = readClosed(env, LOG_SEAL_ENV, LOG_SEAL_VALUES, DEFAULT_LOG_SEAL);
	return {
		level: typeof level === 'object' ? 'refused' : level,
		securityLog: typeof securityLog === 'object' ? 'refused' : securityLog,
		logSeal: typeof logSeal === 'object' ? 'refused' : logSeal
	};
}

/**
 * What the writer uses before the boot check has run. A malformed value falls back to the default
 * HERE only so that the refusal itself can be written; the boot collector refuses to start on it,
 * so no instance ever serves requests under a value other than the one configured.
 */
export function readLogSettings(env: Env): {
	level: LogLevelSetting;
	securityLog: SecurityLogSetting;
} {
	const level = readClosed(env, LOG_LEVEL_ENV, LOG_LEVELS, DEFAULT_LOG_LEVEL);
	const securityLog = readClosed(env, SECURITY_LOG_ENV, SECURITY_LOG_VALUES, DEFAULT_SECURITY_LOG);
	return {
		level: typeof level === 'object' ? DEFAULT_LOG_LEVEL : level,
		securityLog: typeof securityLog === 'object' ? DEFAULT_SECURITY_LOG : securityLog
	};
}

export function resolveLogSeal(env: Env): LogSealSetting {
	const value = readClosed(env, LOG_SEAL_ENV, LOG_SEAL_VALUES, DEFAULT_LOG_SEAL);
	if (typeof value === 'object') throw new OperatorFacingError(value.refused);
	return value;
}

/**
 * What the sealer uses at writer creation, before the boot check has run, by the same rule as
 * `readLogSettings`: a refused value falls back here only so the refusal can be written, and the
 * boot check (`BP_LOG_SEAL` in `assertLoggingConfigured`, the interval through
 * `readIntegerSetting`) refuses to start on it. The interval accepts the digits 0 to 9 only, within
 * its bounds, as the boot check does.
 */
export function readSealSettings(env: Env): {
	seal: LogSealSetting;
	dir: string | undefined;
	intervalSeconds: number;
} {
	const seal = readClosed(env, LOG_SEAL_ENV, LOG_SEAL_VALUES, DEFAULT_LOG_SEAL);
	const interval = trimmedValue(env, LOG_SEAL_INTERVAL_ENV) ?? '';
	const seconds = /^[0-9]+$/.test(interval) ? Number(interval) : Number.NaN;
	return {
		seal: typeof seal === 'object' ? DEFAULT_LOG_SEAL : seal,
		dir: trimmedValue(env, LOG_SEAL_DIR_ENV) || undefined,
		intervalSeconds:
			seconds >= MIN_LOG_SEAL_INTERVAL && seconds <= MAX_LOG_SEAL_INTERVAL
				? seconds
				: DEFAULT_LOG_SEAL_INTERVAL
	};
}
