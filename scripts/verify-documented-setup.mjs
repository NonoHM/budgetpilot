#!/usr/bin/env node
/**
 * THE DOCUMENTED SETUP, RUN RATHER THAN READ.
 *
 * `npx prisma generate` produces the client for the CONFIGURED provider only, while
 * `src/lib/server/database/client.ts` imports all three statically. A clone that followed the old
 * printed line therefore installed, generated, and then failed at `npm run build` with
 * « Module not found: ./generated/postgresql/client.ts ». That was #474, and the line was
 * corrected to `npm run db:generate`.
 *
 * ## Why the correction alone is not the fix
 *
 * Nothing could see it. Every CI job runs its own « Generate Prisma clients » step before anything
 * else, `docker-smoke` builds through the Dockerfile rather than through the documented steps, and
 * a developer's tree has held all three clients since the first time they ran `db:generate`. The
 * only thing that can observe the install path is something that walks it, and until this script
 * that was a manual step performed once per chantier.
 *
 * ## Why it is not an install hook instead
 *
 * The obvious repair, running `db:generate` from `prepare` or `postinstall` so the tree is never in
 * the broken state, is not available in the shape #474 assumed. `Dockerfile:36-37` runs `npm ci`
 * with only `package.json` and the lockfile in scope, so a hook needing `prisma/` either fails the
 * image build or is swallowed by the existing `|| echo ''`, and a swallowed generate leaves exactly
 * the broken tree with no signal. `Dockerfile:61-68` records the other half: `prisma generate` also
 * needs `svelte-kit sync` to have run first. So the documented steps stay the contract and this is
 * what holds them to it.
 *
 * ## The commands are READ from `setup.mjs`, never retyped
 *
 * Two sides of one comparison must not come from two sources. A retyped command list would agree
 * with the script by review and would keep passing on the day somebody edits one of them.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SETUP = 'scripts/setup.mjs';

/**
 * Commands are only skipped by an explicit, PRINTED list. A gate that silently drops a step reports
 * on a smaller thing than it claims to.
 */
const SKIP = [
	{ match: /npm run dev\b/, why: 'starts a server and never exits' },
	{ match: /docker compose/, why: 'the Docker branch is covered by docker-smoke' }
];

const source = readFileSync(SETUP, 'utf8');

/**
 * The lines the script PRINTS as commands: a `console.log` of a literal beginning with two spaces,
 * which is how every step under « Next steps » is written.
 */
const printed = [...source.matchAll(/console\.log\(\s*[`'"] {2}([^`'"]+)[`'"]\s*\)/g)].map(
	(match) => match[1].trim()
);

// CALIBRATION: an empty list and a list of passing commands produce the same green, so refuse the
// empty one. The figure is the count this file has today; a step added or removed is meant to be
// noticed here rather than to slip through as a smaller sweep.
if (printed.length < 3) {
	throw new Error(
		`read ${printed.length} printed commands from ${SETUP}, expected at least 3. ` +
			'The extraction stopped matching rather than the script losing steps.'
	);
}
console.log(`read ${printed.length} printed commands from ${SETUP}:`);
for (const command of printed) console.log(`  ${command}`);

// The one token this exists for, asserted rather than assumed: the printed line must not be the
// single-provider `prisma generate` that #474 was about.
const generates = printed.filter((command) => /prisma generate|db:generate/.test(command));
if (generates.length !== 1) {
	throw new Error(
		`expected exactly one generate step among the printed commands, saw ${generates.length}`
	);
}
if (/npx prisma generate/.test(generates[0])) {
	throw new Error(
		`${SETUP} prints "${generates[0]}". \`npx prisma generate\` makes the client for the ` +
			'configured provider only, and client.ts imports all three. That is #474.'
	);
}

let ran = 0;
for (const command of printed) {
	const skipped = SKIP.find((rule) => rule.match.test(command));
	if (skipped) {
		console.log(`\nSKIP  ${command}\n      (${skipped.why})`);
		continue;
	}
	console.log(`\nRUN   ${command}`);
	execSync(command, { stdio: 'inherit' });
	ran += 1;
}

// Following the steps has to leave a tree that BUILDS, which is the failure #474 reported. `check`
// as well as `build`, because they fail on different things: `check` saw the missing client as two
// type errors and `build` as a module resolution failure.
for (const command of ['npm run check', 'npm run build']) {
	console.log(`\nRUN   ${command}`);
	execSync(command, {
		stdio: 'inherit',
		/**
		 * `DATABASE_URL` is supplied for the BUILD and it is not a workaround.
		 *
		 * `vite.config.ts` deliberately does not load `.env` at build mode and `db.ts` throws for
		 * its absence, so `npm run build` from a clean shell fails on every branch including `main`.
		 * That is the state of that gate rather than anything this script measures, and every real
		 * caller supplies one: CI's own build step and the Dockerfile both do. Supplying it here is
		 * what keeps this script pointed at #474's failure, which is a module that does not resolve,
		 * rather than at a missing variable it would report instead.
		 *
		 * The value never opens a connection. `build` reads it for its presence alone.
		 */
		env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./verify-setup.db' }
	});
	ran += 1;
}

console.log(
	`\nOK: ${ran} commands ran, ${printed.length - (ran - 2)} skipped by the printed list.`
);
