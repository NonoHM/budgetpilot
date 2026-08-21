// Interactive first-run setup: generates .env from .env.example, filling in
// the three required secrets and the optional-feature toggles. Replaces the
// manual "copy .env.example, run openssl three times, paste" flow.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import path from 'node:path';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envExamplePath = path.join(rootDir, '.env.example');
const envPath = path.join(rootDir, '.env');

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Iterate lines directly rather than calling rl.question() repeatedly: with
// piped/non-TTY stdin, readline can see 'end' on the underlying stream right
// after the first read and close itself, silently breaking every question
// after the first. The async iterator consumes buffered lines correctly.
const lines = rl[Symbol.asyncIterator]();

async function askYesNo(question, { defaultYes = false } = {}) {
	const hint = defaultYes ? 'Y/n' : 'y/N';
	process.stdout.write(`${question} (${hint}) `);
	const { value, done } = await lines.next();
	const answer = (done ? '' : value).trim().toLowerCase();
	if (!answer) return defaultYes;
	return answer === 'y' || answer === 'yes';
}

async function askPort(question, defaultPort) {
	process.stdout.write(`${question} [${defaultPort}] `);
	const { value, done } = await lines.next();
	const answer = (done ? '' : value).trim();
	if (!answer) return defaultPort;
	if (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > 65535) {
		console.log(`"${answer}" isn't a valid port, using ${defaultPort} instead.`);
		return defaultPort;
	}
	return Number(answer);
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once('error', (err) => {
			if (err.code !== 'EADDRINUSE') {
				console.log(`Couldn't check port ${port} (${err.code}), assuming it's free.`);
				resolve(true);
				return;
			}
			resolve(false);
		});
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '0.0.0.0');
	});
}

async function findFreePort(startPort, { limit = 50 } = {}) {
	for (let port = startPort; port < startPort + limit; port++) {
		if (await isPortFree(port)) return port;
	}
	return null;
}

// The optional leading `#` is for keys the template ships COMMENTED OUT, which is how a variable
// says "leave me absent unless you know you need me". ORIGIN is the one: absent, docker-compose
// derives it from APP_PORT, so remapping the published port fixes it by itself; a value written
// into .env would win over that default and re-create the mismatch it exists to prevent. Setup
// still writes a real value, because it has just asked for the port. The "template out of date"
// guard is unchanged — a key missing in BOTH forms is still an error, not a silent no-op.
function setEnvValue(content, key, value) {
	const pattern = new RegExp(`^#?${key}=.*$`, 'm');
	if (!pattern.test(content)) {
		throw new Error(`${key} not found in .env.example. Is the template out of date?`);
	}
	return content.replace(pattern, `${key}=${value}`);
}

console.log('BudgetPilot setup\n');
console.log("This walks you through creating your .env file. It won't touch anything else.\n");

if (existsSync(envPath)) {
	console.log(
		'.env already exists. Continuing replaces the WHOLE file from the template, including any values you edited by hand (ORIGIN, bank sync credentials, ...), and rotates all three secrets.'
	);
	console.log(
		'Rotating TOTP_ENCRYPTION_KEY breaks two-factor login for any account that already has it enabled.'
	);
	const overwrite = await askYesNo('Continue anyway?', { defaultYes: false });
	if (!overwrite) {
		console.log(
			'\nKept your existing .env untouched. To flip a single setting, edit .env directly instead of rerunning this script.'
		);
		rl.close();
		process.exit(0);
	}
}

const useDocker = await askYesNo('\nWill you run BudgetPilot with Docker?', { defaultYes: true });

let appPort = 3000;
if (useDocker) {
	if (await isPortFree(3000)) {
		appPort = 3000;
	} else {
		console.log('\nPort 3000 is already in use on this machine.');
		const suggestion = await findFreePort(3001);
		appPort = await askPort('Which host port should BudgetPilot use instead?', suggestion ?? 3001);
		if (!(await isPortFree(appPort))) {
			const fallback = await findFreePort(appPort + 1);
			if (fallback) {
				console.log(`Port ${appPort} is also taken, using ${fallback} instead.`);
				appPort = fallback;
			} else {
				console.log(
					`Port ${appPort} is also taken, and no free port was found nearby. Writing it anyway. Edit APP_PORT in .env before running docker compose up.`
				);
			}
		}
	}
}

const enableLlm = await askYesNo(
	'\nEnable optional local AI advice (Ollama)? You can turn this on later in .env.',
	{ defaultYes: false }
);

const enableBankSync = await askYesNo(
	'Enable optional automatic bank sync (Enable Banking)? You can turn this on later in .env.',
	{ defaultYes: false }
);

rl.close();

let content = await readFile(envExamplePath, 'utf8');

const bootstrapToken = randomBytes(32).toString('base64');
const rateLimitHashSecret = randomBytes(32).toString('hex');
const totpEncryptionKey = randomBytes(32).toString('hex');

content = setEnvValue(content, 'BOOTSTRAP_TOKEN', bootstrapToken);
content = setEnvValue(content, 'RATE_LIMIT_HASH_SECRET', rateLimitHashSecret);
content = setEnvValue(content, 'TOTP_ENCRYPTION_KEY', totpEncryptionKey);
content = setEnvValue(content, 'LLM_ENABLED', String(enableLlm));
content = setEnvValue(content, 'BANK_SYNC_ENABLED', String(enableBankSync));
if (useDocker) {
	content = setEnvValue(content, 'APP_PORT', String(appPort));
	content = setEnvValue(content, 'ORIGIN', `http://localhost:${appPort}`);
	// Without this the documented Docker install does not boot at all, and the reason is invisible
	// from either file alone. .env.example ships DATABASE_URL="file:./dev.db", which is right for
	// the no-Docker path; docker-compose.yml writes `${DATABASE_URL:-file:/data/budgetpilot.db}`, a DEFAULT
	// deliberately left overridable so a PostgreSQL or MySQL URL in .env wins. So the .env this
	// script writes won that fallback with a relative path, `.` inside the container is /app, /app
	// is read-only by design, and the container crash-looped on "the SQLite database cannot be
	// written" from the first boot onward. `npm run setup && docker compose up -d --build` is
	// exactly what docs/getting-started.md option B prescribes.
	content = setEnvValue(content, 'DATABASE_URL', 'file:/data/budgetpilot.db');
}

await writeFile(envPath, content, 'utf8');

console.log('\n.env created with three freshly generated secrets.\n');

console.log('Next steps:\n');
if (useDocker) {
	console.log('  docker compose up -d --build');
	console.log(`\nThen open http://localhost:${appPort}`);
} else {
	console.log('  npx prisma generate && npx prisma migrate dev');
	console.log('  npm run dev');
	console.log('\nThen open http://localhost:5173');
}

console.log(
	'\nThe first account you register needs the BOOTSTRAP_TOKEN from your new .env. That account becomes an admin automatically.'
);

if (enableLlm) {
	console.log(
		useDocker
			? '\nAI enabled: use docker-compose.ai.yml (see README) to also start the Ollama service.'
			: '\nAI enabled: run "npm run setup:llm" to install Ollama and pull the model, then "npm run dev:ai".'
	);
}

if (enableBankSync) {
	console.log(
		'\nBank sync enabled: you still need to set ENABLE_BANKING_APP_ID and a private key in .env. See the comments there.'
	);
}
