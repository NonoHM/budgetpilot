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
