// Exec-form Docker healthcheck. The runtime image is distroless: no shell, no curl, no wget,
// so the probe is node itself, and both the Dockerfile HEALTHCHECK and the compose healthcheck
// have to spell it out as ['CMD', '/nodejs/bin/node', 'healthcheck.mjs'] rather than CMD-SHELL.
//
// It probes /login, which is the liveness signal every other check in this repo already uses
// (scripts/docker-smoke.sh, the arm64 verification in docker-publish.yml): it is a PUBLIC_ROUTE,
// and adapter-node only opens the socket after hooks.server.ts's `init` has queried the
// database, so an answer at all means the client for this provider loaded and ran real queries.
//
// Any status below 500 counts as healthy on purpose. The question is "is the server up", not
// "does this page render" — a 302 to a locale or an auth redirect is a perfectly alive server.
import http from 'node:http';

const req = http.get(
	{
		host: '127.0.0.1',
		port: Number(process.env.PORT ?? 3000),
		path: '/login',
		timeout: 4000
	},
	(res) => {
		// Drained rather than left dangling: without this the socket stays open and the process
		// waits on it instead of exiting with the verdict.
		res.resume();
		process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1);
	}
);

// `timeout` only fires the event; it does not abort the request. Destroying it turns the stall
// into the error below, which is what makes the probe exit within the HEALTHCHECK timeout.
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
