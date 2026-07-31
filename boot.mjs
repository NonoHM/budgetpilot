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
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
const databaseUrl = process.env.DATABASE_URL ?? 'file:/data/dev.db';
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
	//               truncate whatever it pointed at. Pointed at dev.db, that is the database
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
			console.error(
				`${directory} is on a read-only filesystem, so the SQLite database cannot be ` +
					'written. The container runs with a read-only root filesystem by design, and ' +
					`${directory} is expected to be a mounted volume — nothing is mounted there.\n` +
					'In Compose that is the `budgetpilot_data:/data` volume the shipped files ' +
					'declare; check it has not been removed. With plain docker run, add ' +
					'`-v budgetpilot_data:/data`.' +
					(directory === '/data'
						? ''
						: `\nNote that DATABASE_URL points at ${directory}, not at /data. Inside the ` +
							'container the SQLite file has to live on the mounted volume: set ' +
							'DATABASE_URL=file:/data/dev.db.')
			);
		} else if (error.code === 'EACCES' || error.code === 'EPERM') {
			console.error(
				`${directory} is not writable by uid ${uid}. If you upgraded from an image older ` +
					'than the distroless one, the volume is still owned by the old uid.\n' +
					"Fix it once, with the container stopped. Find the volume's real name first — " +
					'Compose prefixes it with the project name, so what docker-compose.yml calls ' +
					'budgetpilot_data is usually budgetpilot_budgetpilot_data:\n' +
					'  docker volume ls\n' +
					'  docker run --rm -v <that name>:/data busybox chown -R 65532:65532 /data\n' +
					'Get the name wrong and this still exits 0: `-v` silently creates a volume that ' +
					'does not exist, chowns that empty one, and changes nothing here. For a bind ' +
					'mount instead: sudo chown -R 65532:65532 /your/host/path'
			);
		} else {
			console.error(
				`${directory} could not be written by uid ${uid}: ${error.code ?? error.message}. ` +
					'The SQLite database lives there, so the app cannot start.'
			);
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
	console.error(`prisma migrate deploy exited with ${code}; refusing to start`);
	process.exit(code ?? 1);
}

await import('./build/index.js');
