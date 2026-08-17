import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';
import { findCollidingPairs } from '$lib/server/import/collision';
import { deleteImportBatch } from '$lib/server/import/deleteBatch';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const cancelled = url.searchParams.get('cancelled') === '1';
	const batches = await prisma.importBatch.findMany({
		where: { userId: user.id },
		orderBy: { createdAt: 'desc' },
		take: 50,
		select: {
			id: true,
			fileName: true,
			source: true,
			profile: true,
			rowCount: true,
			importedRows: true,
			duplicateRows: true,
			invalidRows: true,
			periodStart: true,
			periodEnd: true,
			createdAt: true,
			_count: { select: { transactions: true } },
			// The correspondance this batch was read through, for the plate's §3.7 block. Reached
			// through the batch's own relation, so the `userId` on the outer where clause is what
			// scopes it: a mapping is never looked up by fingerprint here, and the fingerprint is
			// exactly the key that would read another customer of the same bank.
			columnMapping: {
				select: { id: true, createdAt: true, useCount: true }
			}
		}
	});

	/**
	 * Imports that already doubled, found by comparing what is stored rather than what arrives.
	 *
	 * The check that runs before a write cannot help anyone whose statement was doubled before it
	 * shipped: the fingerprints are written and nothing can recompute them. The comparison itself
	 * still works, because a batch's period, its row count and its totals are all still here, and
	 * without it a user has no way to find out at all. That was the state the blind usability session
	 * ended in, with two identical imports on this very page and nothing saying so.
	 *
	 * Read on the ordinary load rather than behind an action: a warning the user has to ask for is a
	 * warning for people who already suspect.
	 */
	const collisions = await findCollidingPairs(user.id);

	return {
		cancelled,
		collisions,
		batches: batches.map((batch) => ({
			id: batch.id,
			fileName: batch.fileName,
			source: batch.source,
			profile: batch.profile,
			rowCount: batch.rowCount,
			importedRows: batch.importedRows,
			duplicateRows: batch.duplicateRows,
			invalidRows: batch.invalidRows,
			periodStart: batch.periodStart?.toISOString().slice(0, 10) ?? null,
			periodEnd: batch.periodEnd?.toISOString().slice(0, 10) ?? null,
			createdAt: batch.createdAt.toISOString(),
			transactionCount: batch._count.transactions,
			columnMapping: batch.columnMapping
				? {
						id: batch.columnMapping.id,
						memorisedAt: batch.columnMapping.createdAt.toISOString(),
						// `useCount` is incremented only by imports that actually produced transactions,
						// so this is how often the correspondance WORKED rather than how often it was
						// consulted. The designating run is one of them.
						useCount: batch.columnMapping.useCount
					}
				: null
		}))
	};
};

export const actions: Actions = {
	cancel: async ({ locals, request }) => {
		const user = requireUser(locals.user);
		const formData = await request.formData();
		const batchId = normalizeId(getFormValue(formData, 'batchId'));

		if (!batchId) {
			return fail(400, { error: m.imports_error_invalid() });
		}

		// The same implementation the correction path calls when it replaces the batch it was
		// launched from. The lookup moved inside it, so a database failure while resolving the batch
		// now reports `cancel_failed` where it used to surface as an unhandled error; the two 404
		// and 500 shapes the page renders are unchanged.
		let deleted = false;
		try {
			deleted = await deleteImportBatch(user.id, batchId);
		} catch {
			return fail(500, { error: m.imports_error_cancel_failed() });
		}
		if (!deleted) return fail(404, { error: m.imports_error_not_found() });

		throw redirect(303, '/imports?cancelled=1');
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value.trim() : '';
}
