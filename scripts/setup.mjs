// Interactive first-run setup: generates .env from .env.example, filling in
// the three required secrets and the optional-feature toggles. Replaces the
// manual "copy .env.example, run openssl three times, paste" flow.
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

function setEnvValue(content, key, value) {
	const pattern = new RegExp(`^${key}=.*$`, 'm');
	if (!pattern.test(content)) {
		throw new Error(`${key} not found in .env.example — is the template out of date?`);
	}
	return content.replace(pattern, `${key}=${value}`);
}

console.log('BudgetPilot setup\n');
console.log("This walks you through creating your .env file. It won't touch anything else.\n");

if (existsSync(envPath)) {
	const overwrite = await askYesNo(
		'.env already exists. Overwrite it with a freshly generated one?',
		{ defaultYes: false }
	);
	if (!overwrite) {
		console.log('\nKept your existing .env untouched. Nothing was changed.');
		rl.close();
		process.exit(0);
	}
}

const useDocker = await askYesNo('\nWill you run BudgetPilot with Docker?', { defaultYes: true });

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

await writeFile(envPath, content, 'utf8');

console.log('\n.env created with three freshly generated secrets.\n');

console.log('Next steps:\n');
if (useDocker) {
	console.log('  docker compose up -d --build');
	console.log('\nThen open http://localhost:3000');
} else {
	console.log('  npx prisma generate && npx prisma migrate dev');
	console.log('  npm run dev');
	console.log('\nThen open http://localhost:5173');
}

console.log(
	'\nThe first account you register needs the BOOTSTRAP_TOKEN from your new .env — it becomes an admin automatically.'
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
		'\nBank sync enabled: you still need to set ENABLE_BANKING_APP_ID and a private key in .env — see the comments there.'
	);
}
