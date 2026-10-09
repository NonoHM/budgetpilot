import { env } from '$env/dynamic/private';
import { rateLimitIpv6PrefixBits } from '$lib/server/auth/rateLimitConfig';
import { readRateLimitSecret } from '$lib/server/auth/rateLimitSecret';
import {
	deriveLogPseudonymKey,
	deriveLogSubnetKey,
	deriveLogUserKey,
	logPseudonymWith,
	logSubnetPseudonymWith,
	logSubnetWith,
	logUserPseudonymWith,
	type LogPseudonym,
	type LogSubnet,
	type LogSubnetPseudonym,
	type LogUserPseudonym
} from './pseudonymDerivation';

// The labels, the key derivation and the keyed hashes live in `pseudonymDerivation.ts`, which plain
// Node can load (#942); re-exported here so every caller keeps one import.
export {
	LOG_PSEUDONYM_KEY_LABEL,
	LOG_SUBNET_KEY_LABEL,
	LOG_USER_KEY_LABEL,
	deriveLogPseudonymKey,
	deriveLogSubnetKey,
	deriveLogUserKey,
	logPseudonymWith,
	logSubnetPseudonymWith,
	logUserPseudonymWith,
	type LogPseudonym,
	type LogSubnet,
	type LogSubnetPseudonym,
	type LogUserPseudonym
} from './pseudonymDerivation';

interface InstanceKeys {
	address: Buffer;
	subnet: Buffer;
	user: Buffer;
}

let cached: (InstanceKeys & { secret: string }) | undefined;

/** The three keys under THIS instance's secret, read lazily like the limiter's own. */
function instanceKeys(): InstanceKeys {
	const secret = readRateLimitSecret(env);
	if (cached?.secret !== secret) {
		cached = {
			secret,
			address: deriveLogPseudonymKey(secret),
			subnet: deriveLogSubnetKey(secret),
			user: deriveLogUserKey(secret)
		};
	}
	return cached;
}

/** The pseudonym under THIS instance's secret. */
export function logPseudonym(value: string): LogPseudonym {
	return logPseudonymWith(instanceKeys().address, value);
}

/** The subnet label under THIS instance's secret, at the prefix the limiter reads now. */
export function logSubnetPseudonym(value: string): LogSubnetPseudonym {
	return logSubnetPseudonymWith(instanceKeys().subnet, value, rateLimitIpv6PrefixBits());
}

/** The subnet label and its width under THIS instance's secret, at the prefix the limiter reads now. */
export function logSubnet(value: string): LogSubnet {
	return logSubnetWith(instanceKeys().subnet, value, rateLimitIpv6PrefixBits());
}

/** The user pseudonym under THIS instance's secret. */
export function logUserPseudonym(userId: string): LogUserPseudonym {
	return logUserPseudonymWith(instanceKeys().user, userId);
}
