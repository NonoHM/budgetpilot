import { describe, expect, it } from 'vitest';
import { OperatorFacingError } from '../operatorFacingError';
import {
	DEFAULT_LOG_LEVEL,
	DEFAULT_SECURITY_LOG,
	LOG_LEVELS,
	readLogSettings,
	resolveLogLevel,
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
