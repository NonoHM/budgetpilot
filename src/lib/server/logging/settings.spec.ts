import { describe, expect, it } from 'vitest';
import { OperatorFacingError } from '../operatorFacingError';
import { REGISTRY } from './events';
import {
	DEFAULT_LOG_LEVEL,
	DEFAULT_SECURITY_LOG,
	LOG_LEVELS,
	readLogSettings,
	readSealSettings,
	resolveLogLevel,
	resolveLogSeal,
	resolveSecurityLog
} from './settings';

/**
 * The two settings: the default when unset or blank, every member of the domain accepted, and a
 * value outside it REFUSED with a sentence naming the domain, never clamped to the nearest member.
 */

describe('BP_LOG_LEVEL', () => {
	it('is info when unset or blank, which is the default the documentation states', () => {
		expect([
			resolveLogLevel({}),
			resolveLogLevel({ BP_LOG_LEVEL: '  ' }),
			DEFAULT_LOG_LEVEL
		]).toEqual(['info', 'info', 'info']);
	});

	it('accepts each member of the domain as written', () => {
		expect(LOG_LEVELS.map((level) => resolveLogLevel({ BP_LOG_LEVEL: level }))).toEqual([
			...LOG_LEVELS
		]);
	});

	it('refuses error and fatal, which would silence the startup and configuration warnings, naming the domain', () => {
		for (const value of ['error', 'fatal', 'silent', 'INFO']) {
			let caught: unknown;
			try {
				resolveLogLevel({ BP_LOG_LEVEL: value });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(OperatorFacingError);
			expect((caught as Error).message).toBe(
				`BP_LOG_LEVEL must be one of debug, info, warn (got ${JSON.stringify(value)}). The default is info.`
			);
		}
	});
});

describe('BP_SECURITY_LOG', () => {
	it('is on unless set to off, and refuses anything else', () => {
		expect([
			resolveSecurityLog({}),
			resolveSecurityLog({ BP_SECURITY_LOG: 'off' }),
			DEFAULT_SECURITY_LOG
		]).toEqual(['on', 'off', 'on']);
		expect(() => resolveSecurityLog({ BP_SECURITY_LOG: 'false' })).toThrow(
			'BP_SECURITY_LOG must be one of on, off (got "false"). The default is on.'
		);
	});
});

describe('no BP_LOG_LEVEL value silences a startup, configuration or crash event', () => {
	// The documentation promises it (docs/logging.md, docs/configuration.md, .env.example), so it is
	// asserted over every event of the registry those words cover, enumerated rather than listed:
	// `sys_startup`, `sys_crash`, `sys_monitor_disabled` and every `budgetpilot.config.*` event.
	// `warn` is the highest level the setting accepts.
	it('gives each of them WARN or above', () => {
		const covered = Object.entries(REGISTRY).filter(
			([name]) => name.startsWith('sys_') || name.startsWith('budgetpilot.config.')
		);
		expect(covered.length).toBeGreaterThan(5);
		expect(
			covered
				.filter(([, spec]) => spec.severity === 'DEBUG' || spec.severity === 'INFO')
				.map(([name]) => name)
		).toEqual([]);
		expect(LOG_LEVELS.at(-1)).toBe('warn');
	});
});

describe('readLogSettings', () => {
	it('falls back to each default for a refused value, so the refusal itself can still be written', () => {
		expect(readLogSettings({ BP_LOG_LEVEL: 'loud', BP_SECURITY_LOG: 'maybe' })).toEqual({
			level: 'info',
			securityLog: 'on'
		});
		expect(readLogSettings({ BP_LOG_LEVEL: 'warn', BP_SECURITY_LOG: 'off' })).toEqual({
			level: 'warn',
			securityLog: 'off'
		});
	});
});

describe('the log seal settings (#875)', () => {
	it('refuses a BP_LOG_SEAL outside off and on, naming the domain', () => {
		expect([resolveLogSeal({}), resolveLogSeal({ BP_LOG_SEAL: ' on ' })]).toEqual(['off', 'on']);
		expect(() => resolveLogSeal({ BP_LOG_SEAL: 'true' })).toThrow(
			new OperatorFacingError(
				'BP_LOG_SEAL must be one of off, on (got "true"). The default is off.'
			)
		);
	});

	// The boundary values on each side: 59 and 86401 refused, 60 and 86400 read, through the boot
	// check's reader, which takes the bounds from the registry.
	it('refuses a BP_LOG_SEAL_INTERVAL outside 60 to 86400 seconds rather than clamping it', async () => {
		const { readIntegerSetting } = await import('../env/readSetting');
		const read = (value: string) => {
			try {
				return readIntegerSetting('BP_LOG_SEAL_INTERVAL', { BP_LOG_SEAL_INTERVAL: value });
			} catch (error) {
				return (error as Error).message.split('.')[0];
			}
		};
		expect(['59', '60', '86400', '86401', ''].map(read)).toEqual([
			'BP_LOG_SEAL_INTERVAL=59 is below the minimum of 60',
			60,
			86400,
			'BP_LOG_SEAL_INTERVAL=86401 is above the ceiling of 86400',
			900
		]);
	});

	// What the writer runs on before the boot check: the default for a value the boot check will
	// refuse, never a clamp, so a refused value can be written about.
	it('reads the defaults for refused values at writer creation, and an empty directory as unset', () => {
		expect(
			[
				{ BP_LOG_SEAL: 'yes', BP_LOG_SEAL_INTERVAL: '59', BP_LOG_SEAL_DIR: '' },
				{ BP_LOG_SEAL: 'on', BP_LOG_SEAL_INTERVAL: '0x3c', BP_LOG_SEAL_DIR: '  ' },
				{ BP_LOG_SEAL: 'on', BP_LOG_SEAL_INTERVAL: '60', BP_LOG_SEAL_DIR: '/data/log-seal' }
			].map(readSealSettings)
		).toEqual([
			{ seal: 'off', dir: undefined, intervalSeconds: 900 },
			{ seal: 'on', dir: undefined, intervalSeconds: 900 },
			{ seal: 'on', dir: '/data/log-seal', intervalSeconds: 60 }
		]);
	});
});
