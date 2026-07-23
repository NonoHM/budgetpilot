import { fail, redirect, type Actions } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { normalizeId } from '$lib/server/transactions/where';
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
			_count: { select: { transactions: true } }
		}
	});

	return {
		cancelled,
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
			transactionCount: batch._count.transactions
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

		const batch = await prisma.importBatch.findFirst({
			where: { id: batchId, userId: user.id },
			select: { id: true }
		});
		if (!batch) return fail(404, { error: m.imports_error_not_found() });

		try {
			await prisma.$transaction([
				prisma.transaction.deleteMany({ where: { userId: user.id, importBatchId: batch.id } }),
				prisma.importBatch.delete({ where: { id: batch.id } })
			]);
		} catch {
			return fail(500, { error: m.imports_error_cancel_failed() });
		}

		throw redirect(303, '/imports?cancelled=1');
	}
};

function getFormValue(formData: FormData, key: string): string {
	const value = formData.get(key);
	return typeof value === 'string' ? value.trim() : '';
}
