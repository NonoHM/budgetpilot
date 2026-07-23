import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEnableBankingCredentials } from './jwt';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

let tmpDir: string | undefined;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

function writeTempPemFile(content: string): string {
	tmpDir = mkdtempSync(join(tmpdir(), 'enablebanking-jwt-'));
	const filePath = join(tmpDir, 'key.pem');
	writeFileSync(filePath, content, 'utf8');
	return filePath;
}

describe('getEnableBankingCredentials — inline key', () => {
	it('returns the credentials from ENABLE_BANKING_PRIVATE_KEY, decoding literal "\\n" sequences', () => {
		const literalNewlines = TEST_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_APP_ID: 'test-app',
			ENABLE_BANKING_PRIVATE_KEY: literalNewlines
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toEqual({ appId: 'test-app', privateKeyPem: TEST_PRIVATE_KEY_PEM });
	});
});

describe('getEnableBankingCredentials — ENABLE_BANKING_PRIVATE_KEY_PATH', () => {
	it('reads the PEM from an absolute file path', () => {
		const filePath = writeTempPemFile(TEST_PRIVATE_KEY_PEM);

		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_APP_ID: 'test-app',
			ENABLE_BANKING_PRIVATE_KEY_PATH: filePath
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toEqual({ appId: 'test-app', privateKeyPem: TEST_PRIVATE_KEY_PEM.trim() });
	});

	it('resolves a relative file path against process.cwd()', () => {
		const filePath = writeTempPemFile(TEST_PRIVATE_KEY_PEM);
		const relativePath = relative(process.cwd(), filePath);

		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_APP_ID: 'test-app',
			ENABLE_BANKING_PRIVATE_KEY_PATH: relativePath
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toEqual({ appId: 'test-app', privateKeyPem: TEST_PRIVATE_KEY_PEM.trim() });
	});

	it('throws when both ENABLE_BANKING_PRIVATE_KEY and ENABLE_BANKING_PRIVATE_KEY_PATH are set', () => {
		const filePath = writeTempPemFile(TEST_PRIVATE_KEY_PEM);

		expect(() =>
			getEnableBankingCredentials({
				ENABLE_BANKING_APP_ID: 'test-app',
				ENABLE_BANKING_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
				ENABLE_BANKING_PRIVATE_KEY_PATH: filePath
			} as unknown as NodeJS.ProcessEnv)
		).toThrow(/ENABLE_BANKING_PRIVATE_KEY.*ENABLE_BANKING_PRIVATE_KEY_PATH.*not both/);
	});

	it('throws with the tried paths and the variable name, and never leaks any file content, when the file is missing', () => {
		tmpDir = mkdtempSync(join(tmpdir(), 'enablebanking-jwt-'));
		const missingPath = join(tmpDir, 'does-not-exist.pem');

		try {
			getEnableBankingCredentials({
				ENABLE_BANKING_APP_ID: 'test-app',
				ENABLE_BANKING_PRIVATE_KEY_PATH: missingPath
			} as unknown as NodeJS.ProcessEnv);
			throw new Error('expected getEnableBankingCredentials to throw');
		} catch (caught) {
			const message = (caught as Error).message;
			expect(message).toContain('ENABLE_BANKING_PRIVATE_KEY_PATH');
			expect(message).toContain(missingPath);
			expect(message).not.toContain('PRIVATE KEY');
			expect(message).not.toContain(TEST_PRIVATE_KEY_PEM);
		}
	});
});

describe('getEnableBankingCredentials — unconfigured', () => {
	it('returns null when neither ENABLE_BANKING_PRIVATE_KEY nor ENABLE_BANKING_PRIVATE_KEY_PATH is set', () => {
		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_APP_ID: 'test-app'
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toBeNull();
	});

	it('returns null when the key env vars are set to empty strings', () => {
		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_APP_ID: 'test-app',
			ENABLE_BANKING_PRIVATE_KEY: '',
			ENABLE_BANKING_PRIVATE_KEY_PATH: ''
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toBeNull();
	});

	it('returns null when ENABLE_BANKING_APP_ID is missing, even with a valid inline key', () => {
		const credentials = getEnableBankingCredentials({
			ENABLE_BANKING_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM
		} as unknown as NodeJS.ProcessEnv);

		expect(credentials).toBeNull();
	});
});
