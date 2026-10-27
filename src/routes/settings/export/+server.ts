import { requireUser } from '$lib/server/auth';
import { buildBackupExport } from '$lib/server/backup/export';
import type { RequestHandler } from './$types';
import { logSensitiveRead } from '$lib/server/logging/data';

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals.user);

	const backup = await buildBackupExport(user.id);
	const dateStamp = new Date().toISOString().slice(0, 10);
	logSensitiveRead(user.id, 'backup', backup.transactions.length);

	return new Response(JSON.stringify(backup, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Content-Disposition': `attachment; filename="budgetpilot-backup-${dateStamp}.json"`
		}
	});
};
