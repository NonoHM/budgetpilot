import { parseHostsCsv } from '$lib/server/hosts';
import { OperatorFacingError } from '$lib/server/operatorFacingError';

/**
 * What the model connection is configured to reach, read from the environment and nothing else: the
 * switch, the host allowlist, the digest pin, and whether the host is on this machine (#967).
 *
 * Its own module, apart from `local-llm.ts`, because startup and the boot checks read these and must
 * not import the model door: `eslint.config.js` refuses any import of `local-llm` until a caller is
 * admitted by name (#1009). Nothing here opens a socket.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// host.docker.internal refers to the host machine itself from inside a Docker container:
// it isn't a remote server, so http: remains acceptable (Ollama doesn't serve TLS there).
export const DEFAULT_HTTP_PERMITTED_HOSTS = [...DEFAULT_ALLOWED_HOSTS, 'host.docker.internal'];

export function isLocalLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.LLM_ENABLED === 'true' && (env.LLM_PROVIDER ?? 'ollama') === 'ollama';
}

/**
 * What `/api/tags` prints for a model, and what `sha256sum` of its manifest prints (measured equal on
 * Ollama 0.32.5). Lowercase only, because the comparison is exact: a value that can never equal a
 * listed digest would refuse every generation, so it is refused at boot where the operator reads.
 */
export const MODEL_DIGEST = /^[0-9a-f]{64}$/;

/** The pinned digest, or `null` when none is set. An empty `.env` line is no pin. */
export function modelDigestPin(env: NodeJS.ProcessEnv): string | null {
	return env.BP_LLM_MODEL_DIGEST ? env.BP_LLM_MODEL_DIGEST : null;
}

/** Boot check for `BP_LLM_MODEL_DIGEST` (#967): unset, empty, or a full digest. */
export function assertLlmModelDigestConfigured(env: NodeJS.ProcessEnv = process.env): void {
	const pin = modelDigestPin(env);
	if (pin === null || MODEL_DIGEST.test(pin)) return;
	throw new OperatorFacingError(
		`BP_LLM_MODEL_DIGEST must be 64 lowercase hexadecimal characters, the digest the model ` +
			`server lists for LLM_MODEL (received ${pin.length} characters). \`ollama list\` prints ` +
			'only the first 12; docs/reference/ai-model.md shows how to read the whole digest.'
	);
}

function getAllowedHosts(env: NodeJS.ProcessEnv): string[] {
	const hosts = parseHostsCsv(env.LLM_ALLOWED_HOSTS);
	return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

// Internal hosts (Docker Compose network, host aliases...) where Ollama doesn't serve TLS:
// http: remains acceptable there in addition to the localhost/127.0.0.1/::1/host.docker.internal baseline.
// Nothing hardcoded here beyond that baseline: any additional host goes through the env var.
function getHttpPermittedHosts(env: NodeJS.ProcessEnv): string[] {
	return [...DEFAULT_HTTP_PERMITTED_HOSTS, ...parseHostsCsv(env.LLM_HTTP_PERMITTED_HOSTS)];
}

/**
 * The model host, when it is not on this machine and the connection would send to it (#967,
 * ANSSI-PA-102 R34); `null` when the connection is off or its base URL is refused, because nothing
 * is then sent anywhere. Startup names it, because whatever a feature sends the model leaves this
 * machine for it.
 *
 * Only the base URL's host is judged: the model host gets no redirect (`NO_REDIRECT` in `local-llm.ts`), so no other
 * allowlisted host is ever sent anything.
 *
 * « This machine » is the loopback names, `host.docker.internal`, and a SINGLE-LABEL name the
 * operator declares internal in `LLM_HTTP_PERMITTED_HOSTS`, which is how the AI overlay declares its
 * `ollama` container (a Compose service name has no dot). A dotted name or an address declared there
 * is still named: a declaration that plain http is acceptable is not proof the host is local. The
 * known limit is a single-label name for another machine, which is taken at the operator's word.
 */
export function remoteModelHost(env: Record<string, string | undefined>): string | null {
	if (!isLocalLlmEnabled(env)) return null;
	const baseUrl = getLocalBaseUrl(env.LLM_BASE_URL ?? DEFAULT_BASE_URL, env);
	if (baseUrl === null) return null;
	const host = new URL(baseUrl).hostname;
	const declared = getHttpPermittedHosts(env).includes(host);
	const onThisMachine =
		DEFAULT_HTTP_PERMITTED_HOSTS.includes(host) ||
		(declared && !host.includes('.') && !host.includes(':'));
	return onThisMachine ? null : host;
}

export function getLocalBaseUrl(value: string, env: NodeJS.ProcessEnv): string | null {
	try {
		const url = new URL(value);
		const allowedHosts = getAllowedHosts(env);
		const isAllowedHost = allowedHosts.includes(url.hostname);
		if (!isAllowedHost) return null;

		const isHttpPermitted = getHttpPermittedHosts(env).includes(url.hostname);
		const hasValidProtocol = isHttpPermitted ? url.protocol === 'http:' : url.protocol === 'https:';
		if (!hasValidProtocol) return null;
		url.pathname = url.pathname.replace(/\/+$/, '');
		url.search = '';
		url.hash = '';
		return url.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}
