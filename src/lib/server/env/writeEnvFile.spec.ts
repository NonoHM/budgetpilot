import { afterEach, describe, expect, it } from 'vitest';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The writer behind `npm run setup` (#826). `.env` holds the three secrets, and setup used to write
 * it with the umask's mode: 644 on a usual machine, readable by every local account.
 *
 * Each write runs in a child process that pins the umask to 022, the value measured on the machine
 * where the defect was found. The suite's own umask is not ours to choose, and under a 077 umask the
 * old writer also produced 600, so a test relying on it would pass over the defect.
 */
const MODULE_URL = pathToFileURL(join(process.cwd(), 'scripts/env-file.mjs')).href;

const CHILD = `
process.umask(0o022);
const [, url, target, content] = process.argv;
const { writeEnvFile } = await import(url);
try {
	await writeEnvFile(target, content);
} catch (error) {
	process.stdout.write(String(error.code));
	process.exitCode = 3;
}
`;

const CONTENT = 'BOOTSTRAP_TOKEN=generated-in-a-test\nAPP_PORT=3000\n';

let directory = '';

function fresh(): string {
	directory = mkdtempSync(join(tmpdir(), 'env-file-'));
	return join(directory, '.env');
}

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = '';
});

function writeUnderUmask022(envPath: string, content: string) {
	const child = spawnSync(
		process.execPath,
		['--input-type=module', '-e', CHILD, MODULE_URL, envPath, content],
		{ encoding: 'utf8' }
	);
	return { status: child.status, code: child.stdout, stderr: child.stderr };
}

function modeOf(path: string): string {
	return (statSync(path).mode & 0o777).toString(8);
}

describe('writeEnvFile', () => {
	// Separates a .env created with an explicit 0600 from one created with the umask's mode (644).
	it('creates .env readable and writable by its owner only', () => {
		const envPath = fresh();

		const result = writeUnderUmask022(envPath, CONTENT);

		expect({
			status: result.status,
			stderr: result.stderr,
			mode: modeOf(envPath),
			content: readFileSync(envPath, 'utf8'),
			entries: readdirSync(directory)
		}).toEqual({ status: 0, stderr: '', mode: '600', content: CONTENT, entries: ['.env'] });
	});

	// Separates a writer that REPLACES the file from one that writes into the existing one: a
	// mode passed to writeFile applies only when it creates the file, so an existing 644 .env,
	// which every install made before this fix has, would keep 644.
	it('leaves an existing world-readable .env at 600 when it overwrites it', () => {
		const envPath = fresh();
		writeFileSync(envPath, 'OLD=1\n');
		chmodSync(envPath, 0o644);
		expect(modeOf(envPath)).toBe('644');

		const result = writeUnderUmask022(envPath, CONTENT);

		expect({
			status: result.status,
			stderr: result.stderr,
			mode: modeOf(envPath),
			content: readFileSync(envPath, 'utf8'),
			entries: readdirSync(directory)
		}).toEqual({ status: 0, stderr: '', mode: '600', content: CONTENT, entries: ['.env'] });
	});

	// Separates a writer that cleans up its temporary file on failure from one that leaves a copy
	// of the secrets beside the .env it could not replace. A directory named .env makes the final
	// rename fail after the temporary file has been written.
	it('removes its temporary file when the .env cannot be replaced, and says why', () => {
		const envPath = fresh();
		mkdirSync(envPath);

		const result = writeUnderUmask022(envPath, CONTENT);

		expect({
			status: result.status,
			code: result.code,
			entries: readdirSync(directory),
			insideTheDirectory: readdirSync(envPath)
		}).toEqual({ status: 3, code: 'EISDIR', entries: ['.env'], insideTheDirectory: [] });
	});
});

/**
 * Every call in Node's fs API that can create or replace a file. setup.mjs reads files and writes
 * none itself, so any match there is a second way to the .env.
 */
const FILE_WRITERS =
	/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cp|cpSync|open|openSync|rename|renameSync)\s*\(/g;

describe('scripts/setup.mjs', () => {
	// Separates a setup that writes .env through writeEnvFile from one that writes it directly: the
	// specs above exercise writeEnvFile alone, so a setup.mjs reverted to
	// `writeFile(envPath, content, 'utf8')` would leave them all green while shipping 644.
	it('writes .env through writeEnvFile, once, and through nothing else', () => {
		const source = readFileSync(join(process.cwd(), 'scripts/setup.mjs'), 'utf8');

		expect({
			importsWriter: source.includes("import { writeEnvFile } from './env-file.mjs';"),
			calls: source.match(/\bwriteEnvFile\(envPath, content\)/g)?.length ?? 0,
			otherWriters: source.match(FILE_WRITERS) ?? []
		}).toEqual({ importsWriter: true, calls: 1, otherWriters: [] });
	});

	// The detector's own calibration: the line setup.mjs used to carry is found.
	it('recognises the direct write that setup.mjs used to make', () => {
		expect("await writeFile(envPath, content, 'utf8');".match(FILE_WRITERS)).toEqual([
			'writeFile('
		]);
	});
});
