import { prisma } from '$lib/server/db';
import type { TransactionClient } from '$lib/server/auth';
import { isUniqueConstraintViolation } from '$lib/server/database/upsert';

/**
 * The instance-wide AI kill switch (#986). AISVS 1.0 C9.6.1: « Verify that a manual kill-switch
 * mechanism exists to immediately halt AI model inference and outputs. »
 *
 * TWO HALVES, AND EACH COVERS WHAT THE OTHER CANNOT. The row (`InferenceHalt`) is the state: it
 * survives a restart, and every call reads it before opening a socket (`isInferenceHalted`). The
 * registry below is the immediacy: a call registers before it reads, and a halt aborts everything
 * registered once its row is written. A call that registered before the write is aborted; one that
 * registers after it reads the row. Register-then-read in the door and write-then-abort here are
 * what make those two cases cover every interleaving, and `inferenceHalt.spec.ts` lands a halt
 * inside the read to hold the door to it.
 *
 * ONE PROCESS. The registry reaches calls in this Node process, which is the whole application
 * under adapter-node. A second process would see the row on its next call and miss the abort.
 *
 * Who may halt or lift, and what each logs, is the admin route's (`routes/admin/+page.server.ts`).
 */

/** The one row's key. `InferenceHalt` holds at most this row, so a halt is a fact, not a count. */
const INFERENCE_HALT_ID = 1;

const running = new Set<AbortController>();

/**
 * Halts every model call: writes the row, then aborts each call in flight. Answers whether THIS call
 * created the row, which is what the caller logs: a second press is not a second activation, and the
 * first halt's record (who, when) is kept.
 *
 * A create, never an upsert (design pass F2): Prisma runs an upsert as a read then a write on MySQL
 * and MariaDB (`database/upsert.ts`), so a halt pressed while a lift's transaction has deleted the
 * row but not committed it would read the row, report it already there, and be lost when the lift
 * commits. An insert on the primary key waits for that commit on all three engines instead.
 */
export async function haltInference(userId: string): Promise<boolean> {
	let created: boolean;
	try {
		await prisma.inferenceHalt.create({
			data: { id: INFERENCE_HALT_ID, haltedAt: new Date(), haltedById: userId }
		});
		created = true;
	} catch (caught) {
		if (!isUniqueConstraintViolation(caught)) throw caught;
		created = false;
	}
	// Whether created or found, the instance is halted now, so nothing registered may keep running:
	// a call that slipped in between an earlier halt's abort and this one is stopped too.
	for (const controller of running) controller.abort();
	return created;
}

/**
 * Removes the halt, through `client`, which the lift passes as its transaction so the delete commits
 * with the admin's rotated session (#249) or not at all. Answers whether a row was deleted, which the
 * caller logs AFTER its commit returns (design pass F3). The only delete of this table.
 */
export async function liftInferenceHalt(
	client: Pick<TransactionClient, 'inferenceHalt'>
): Promise<boolean> {
	const { count } = await client.inferenceHalt.deleteMany({ where: { id: INFERENCE_HALT_ID } });
	return count > 0;
}

/** The halt as /admin shows it, or `null` when inference runs. */
export async function readInferenceHalt(): Promise<{
	haltedAt: Date;
	haltedByEmail: string | null;
} | null> {
	const row = await prisma.inferenceHalt.findUnique({
		where: { id: INFERENCE_HALT_ID },
		select: { haltedAt: true, haltedBy: { select: { email: true } } }
	});
	return row ? { haltedAt: row.haltedAt, haltedByEmail: row.haltedBy?.email ?? null } : null;
}

/**
 * Whether the door must refuse. A read that throws answers `true`: a switch whose state cannot be
 * read is not read as « off », or an unreachable database would be a way round it.
 */
export async function isInferenceHalted(): Promise<boolean> {
	try {
		const row = await prisma.inferenceHalt.findUnique({
			where: { id: INFERENCE_HALT_ID },
			select: { id: true }
		});
		return row !== null;
	} catch {
		return true;
	}
}

/**
 * Registers a model call, BEFORE it reads the halt. `signal` aborts when an admin halts; `leave`
 * unregisters, and belongs in a `finally` that opens on the next line.
 */
export function enterInference(): { signal: AbortSignal; leave: () => void } {
	const controller = new AbortController();
	running.add(controller);
	return { signal: controller.signal, leave: () => running.delete(controller) };
}
