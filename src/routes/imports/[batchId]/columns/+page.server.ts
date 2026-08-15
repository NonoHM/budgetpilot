import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { recapDesignation } from '$lib/server/import/mapping/recap';
import { formatCents } from '$lib/domain/budget';
import { getLocale } from '$lib/paraglide/runtime';
import type { PageServerLoad } from './$types';

/**
 * « Voir les colonnes »: the memorised correspondance an import was read through.
 *
 * Ruling A1 keeps the designation screen shut for a recognised file, and the plate states the cost
 * it accepts in doing so: the user never re-sees what was memorised. §3.7 is the compensating path
 * and this is its route. Until it existed the recap was a MODE of a component that nothing opened,
 * covered by three component specs and unreachable from the application.
 *
 * ## Scoped by the batch, always
 *
 * The mapping is reached through `batch.columnMapping` on a batch found by `{ id, userId }`, never
 * by fingerprint and never by mapping id from the URL. A fingerprint is a hash of a bank's PUBLIC
 * column names, so every customer of that bank shares one: a lookup keyed on it alone would read
 * another user's configuration. Reaching the mapping through an owned row makes the safe query the
 * only query there is.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = requireUser(locals.user);

	const batch = await prisma.importBatch.findFirst({
		where: { id: params.batchId, userId: user.id },
		select: {
			id: true,
			fileName: true,
			rowCount: true,
			createdAt: true,
			columnMapping: {
				select: {
					id: true,
					matchBy: true,
					dateColumn: true,
					labelColumn: true,
					amountColumn: true,
					categoryColumn: true,
					dateIndex: true,
					labelIndex: true,
					amountIndex: true,
					categoryIndex: true,
					columnCount: true,
					createdAt: true,
					useCount: true
				}
			}
		}
	});

	// One 404 for "no such batch" and for "that batch has no correspondance". The second is not a
	// permission failure, but distinguishing them here would let a caller enumerate which of
	// another user's ids exist, and there is nothing to gain by separating them.
	if (!batch || !batch.columnMapping) error(404, 'Not found');

	/**
	 * ONE transaction of this batch, rendered per role.
	 *
	 * The value the mapping PRODUCED rather than the value it read, and that is the whole point of
	 * this screen. A correspondance that named the reference column as the label imports every row
	 * of every file with nothing invalid: no count is wrong, no banner appears, and the label is
	 * the only place in the entire application where the mistake is visible.
	 *
	 * The oldest row, so the same import shows the same example every time it is opened.
	 */
	const sampleRow = await prisma.transaction.findFirst({
		where: { userId: user.id, importBatchId: batch.id },
		orderBy: [{ date: 'asc' }, { id: 'asc' }],
		select: {
			date: true,
			label: true,
			amountCents: true,
			type: true,
			category: { select: { name: true } }
		}
	});

	const recap = recapDesignation(batch.columnMapping, {
		fileName: batch.fileName ?? '',
		rowCount: batch.rowCount,
		sample: sampleRow
			? {
					// Rendered as the application renders dates everywhere else, not as ISO. The user is
					// comparing this against their own statement, so it has to be a date they recognise.
					date: sampleRow.date.toLocaleDateString(getLocale()),
					label: sampleRow.label,
					// SIGNED, unlike the transactions list, and the difference is the point of this
					// screen. `amountCents` is stored as a magnitude with the direction in `type`, and
					// the list carries that direction in colour. This row is monochrome by design (§8
					// puts no tinted surface on this screen) and the user is holding it against a
					// statement that writes `-6,40`, so the sign has to be in the text or the value
					// they are comparing is not the value they see.
					amount: formatCents(
						sampleRow.type === 'expense' ? -sampleRow.amountCents : sampleRow.amountCents
					),
					category: sampleRow.category?.name ?? ''
				}
			: {}
	});

	return {
		batchId: batch.id,
		mappingId: batch.columnMapping.id,
		memorisedAt: batch.columnMapping.createdAt.toISOString(),
		useCount: batch.columnMapping.useCount,
		file: recap.file,
		assignment: recap.assignment
	};
};
