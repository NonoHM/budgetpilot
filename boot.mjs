// Shell-free container boot: run `prisma migrate deploy`, then start the server in-process.
//
// This replaces docker-entrypoint.sh. The runtime image is moving to a base with no shell at
// all (gcr.io/distroless/nodejs24-debian13), so the container command has to be a JavaScript
// file that node runs directly.
//
// No code generation at boot. The image carries a generated Prisma client for every supported
// provider, built into ./build, and the app selects one at runtime from DATABASE_PROVIDER.
// Earlier versions regenerated here for anything but SQLite, which is why the image had to
// leave node_modules/.prisma writable by the app user — write access to code that is then
// executed. /data is the only thing the app user can write to now.
//
// migrate deploy still runs per boot, and still reads the schema and migration history for
// DATABASE_PROVIDER through prisma.config.ts. It writes to the database, never to the image.
//
// The Prisma CLI is invoked at its declared bin entry (node_modules/prisma/package.json
// "bin" -> build/index.js) rather than node_modules/.bin/prisma: the .bin shim is a
// #!/usr/bin/env node shebang script, and the runtime image has no /usr/bin/env and no shell.
// Prisma has no supported programmatic migrate API (prisma/prisma#4703), so spawning the CLI
// is the supported interface. Not `npx` either: npx's documented behaviour when it cannot
// resolve a package is to fetch it from the registry and run it, which is a code-execution
// path at container start that depends on the network. Naming the file removes the fallback
// entirely. CHECKPOINT_DISABLE, set in the Dockerfile, suppresses Prisma's version-check
// request and the cache write it makes into HOME, so nothing at boot needs a writable home
// directory; the child inherits it from this process.
//
// The server is started by importing adapter-node's build output, not by spawning a child:
// the import side effect listens on PORT/HOST and installs adapter-node's own SIGTERM/SIGINT
// handlers (drain, then force-close after SHUTDOWN_TIMEOUT). PID 1 gets no default signal
// dispositions from the kernel, but registered handlers fire fine, so no init shim is needed.
// The only window without a handler is the migrate phase below, which installs its own.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// The logger's own core, as TypeScript source (Node strips the types): this file runs before the
// server bundle exists, and its lines belong to the same chain the server continues (#250).
import { createLogWriter, stdoutSink } from './src/lib/server/logging/core.ts';
import { ATTRIBUTE, EVENT } from './src/lib/server/logging/names.ts';
import { readLogSettings } from './src/lib/server/logging/settings.ts';
import { IMAGE_DATABASE_URL, resolveImageDatabaseUrl } from './src/lib/server/database/provider.ts';

const log = createLogWriter({ ...readLogSettings(process.env), sink: stdoutSink() });
/** A filesystem error code, admitted only in the shape of one. */
const FS_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

// The image default, and the one it replaced.
//
// The old name was `dev.db` in production, on every install, because the development filename was
// what the first Dockerfile happened to carry. It is not cosmetic: the path is persisted state
// inside the operator's volume, so changing the default without the adoption below would boot an
// existing install against a new empty file, run migrations into it, and serve an empty app with
// the real database sitting beside it on the same volume. That reads as total data loss at the
// moment it happens, and it is recoverable only by someone who knows to set DATABASE_URL.
//
// Renaming before 1.0 costs this function. After 1.0 it would cost a major, because the default
// path is part of what a major version promises not to move.
//
// The rule itself is `resolveImageDatabaseUrl` in provider.ts, the only definition (#957): every
// other reader in the image (a script, the Prisma CLI) calls it too, so all of them open the file
// this process opens. It ADOPTS, never renames: moving the file would have to move `-wal` and
// `-shm` with it, and a SIGKILL between the three leaves a database whose committed transactions
// are in an orphaned write-ahead log. An unset DATABASE_URL here is the image default, as it always
// was in this file; to every other reader it is the development default.
//
// Announced on stdout rather than done quietly: an operator reading their own logs should be able
// to see which file the app opened, and these lines are the only place that says so.
const imageDatabase = resolveImageDatabaseUrl(process.env.DATABASE_URL ?? IMAGE_DATABASE_URL);
if (imageDatabase.situation === 'legacy-adopted-over-empty') {
	// What every door that opened a missing path left behind: 0 bytes, so no database. Removed so
	// the backup procedure's « does not exist » stays true for this install (owner's ruling on
	// #957), and only while it is still empty: re-read now, since the decision above.
	const stray = IMAGE_DATABASE_URL.slice('file:'.length);
	try {
		if (statSync(stray, { throwIfNoEntry: false })?.size === 0) {
			unlinkSync(stray);
			log({ event: EVENT.bootEmptyDatabaseRemoved, attributes: {} });
		}
	} catch {
		// Gone already (a second container on the volume removed it first), or /data refuses the
		// write: the probe below names that cause in its own line, which a stack trace here would
		// replace. Either way the adoption stands and dev.db is opened.
	}
}
if (
	imageDatabase.situation === 'legacy-adopted' ||
	imageDatabase.situation === 'legacy-adopted-over-empty'
) {
	log({ event: EVENT.bootLegacyDatabaseAdopted, attributes: {} });
}
if (imageDatabase.situation === 'both-hold-a-database') {
	// No rule can tell which the owner means (owner's ruling on #957): keep the configured file, and
	// say so at every start until one of the two leaves /data.
	log({
		event: EVENT.bootTwoDatabases,
		attributes: {
			[ATTRIBUTE.bootDatabaseBytes]: imageDatabase.imageBytes,
			[ATTRIBUTE.bootLegacyDatabaseBytes]: imageDatabase.legacyBytes
		}
	});
}

// Written back, not merely read: `prisma migrate deploy` is spawned below and inherits this
// environment, and the server imported after it reads the same variable, so the decision is taken
// once for the whole process tree.
const databaseUrl = imageDatabase.databaseUrl ?? '';
process.env.DATABASE_URL = databaseUrl;

// SQLite is the only provider that writes to the container's own filesystem, and /data is the
// only place it may write. This check exists for one upgrade in particular: images before the
// distroless base ran as a `useradd --system` uid (typically 999), this one runs as 65532, and a
// named volume or bind mount created by the older image is still owned by the older uid. Without
// this, the first symptom is Prisma reporting SQLITE_CANTOPEN or "unable to open database file",
// which names neither the cause nor the fix.
//
// The remediation has to run in another image because there is no chown in this one — that is
// the point of the base, not an oversight.
// A real write, not accessSync(W_OK): the two ways this fails need different instructions, and
// only the errno tells them apart. accessSync consults the permission bits, so it reports the
// same "no" for a directory owned by another uid and for one on a read-only mount — the second
// of which was hit immediately once the container started running with --read-only and no
// volume at /data, and the ownership advice it printed was useless there.
if (databaseUrl.startsWith('file:')) {
	const directory = path.dirname(databaseUrl.slice('file:'.length));
	// Three properties of this probe file, each closing a way the check itself could do harm:
	//
	//   randomUUID  two containers booting against one volume — a rolling restart, or the second
	//               app instance withBootBackfillLock exists for — would otherwise share one
	//               fixed name and unlink each other's probe, so the loser reads ENOENT and
	//               refuses to start with a message saying the directory is unwritable when it
	//               is. process.pid cannot disambiguate them: it is 1 in every container.
	//   flag: 'wx'  O_EXCL|O_CREAT refuses to follow a symlink instead of opening its target,
	//               and never truncates. With the default 'w', a symlink planted at this path by
	//               anything able to write /data — which, with the root filesystem read-only, is
	//               now the only place a dropped payload can live — would make the next boot
	//               truncate whatever it pointed at. Pointed at the database file, that is the database
	//               emptied and then re-migrated into a clean schema, on a container that starts
	//               and reports healthy.
	//   finally     a SIGKILL between the write and the unlink otherwise leaves the file behind
	//               for good, in the one directory operators back up and screenshot.
	const probe = path.join(directory, `.budgetpilot-write-probe.${randomUUID()}`);
	try {
		try {
			writeFileSync(probe, '', { flag: 'wx' });
		} finally {
			try {
				unlinkSync(probe);
			} catch {
				// Never created, or already gone. Neither says anything about writability.
			}
		}
	} catch (error) {
		const uid = process.getuid();
		if (error.code === 'EROFS') {
			log({
				event: EVENT.bootDataDirReadOnly,
				attributes: { [ATTRIBUTE.bootDirectory]: directory }
			});
		} else if (error.code === 'EACCES' || error.code === 'EPERM') {
			log({
				event: EVENT.bootDataDirNotWritable,
				attributes: { [ATTRIBUTE.bootDirectory]: directory, [ATTRIBUTE.bootUid]: uid }
			});
		} else {
			// The code only, never the message, which is a sentence the platform wrote around a path.
			log({
				event: EVENT.bootDataDirUnusable,
				attributes: {
					[ATTRIBUTE.bootDirectory]: directory,
					[ATTRIBUTE.bootUid]: uid,
					...(typeof error.code === 'string' && FS_ERROR_CODE.test(error.code)
						? { [ATTRIBUTE.errorCode]: error.code }
						: {})
				}
			});
		}
		process.exit(1);
	}
}

const migrate = spawn(
	process.execPath,
	['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
	{ stdio: 'inherit' }
);

const onSignal = (signal) => {
	migrate.kill(signal);
	process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

const code = await new Promise((resolve, reject) => {
	migrate.on('close', resolve);
	migrate.on('error', reject);
});
process.off('SIGTERM', onSignal);
process.off('SIGINT', onSignal);

if (code !== 0) {
	log({ event: EVENT.bootMigrateFailed, attributes: { [ATTRIBUTE.bootExitCode]: code ?? -1 } });
	process.exit(code ?? 1);
}

await import('./build/index.js');
