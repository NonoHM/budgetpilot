import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison (hash both sides so length differences don't leak
 * timing). Used for anti-CSRF state verification in every bank connector — the state
 * echo is attacker-influenced input, per the contract invariants in connectors/types.ts.
 */
export function constantTimeEquals(a: string, b: string): boolean {
	const digestA = createHash('sha256').update(a).digest();
	const digestB = createHash('sha256').update(b).digest();
	return timingSafeEqual(digestA, digestB);
}
