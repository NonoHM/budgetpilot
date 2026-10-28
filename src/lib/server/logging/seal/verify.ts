import { sha256Hex } from '../core.ts';
import { ATTRIBUTE as A, EVENT as E, FIELD, SERVICE_NAME } from '../names.ts';
import { createMerkleTree } from './merkle.ts';
import { openCheckpoint, parseVkey, type CheckpointFields, type Vkey } from './note.ts';

/**
 * Verifies a captured log against one or more verification keys (#875), as
 * `scripts/log-seal.mjs verify` runs it.
 *
 * THE RULING (design note A9). A BREAK is signed content the copy contradicts: a root or a size, a
 * signature, a segment index, a link to a checkpoint or a start that should be in the copy and is
 * not, starts out of order, a start that is not the copy's first but has lost its head, a writer
 * line that does not parse as one, or the keyless chain of #871. Lines no signature covers are
 * UNVERIFIED, listed with a reason and a count and never a break: an unsealed start, a start that
 * ended without its stop checkpoint, a fork after a restored state file. The copy's partial head
 * (rotation) and the newest tail are NOTICES: expected in any live log.
 *
 * NO EXEMPTION RESTS ON AN UNSIGNED FIELD (design note, final passes). A tail is the newest lines
 * only if no verified checkpoint follows its first line in the copy (A13), never because its host
 * tag looks new. A start may begin inside a segment only while no start beginning at seq 1 precedes
 * it (A16). A start that is its host's first in the copy, and not the copy's first start, must link
 * through the volume to a checkpoint an earlier start holds (A14), so a recreated container cannot
 * hide the start removed before it.
 *
 * `status`: `broken` if any break; else `nothing` if no checkpoint verified; else `unverified` if
 * anything is unverified; else `verified`.
 *
 * Imported by `scripts/log-seal.mjs` as TypeScript source: erasable syntax only, relative imports.
 */

export type BreakKind =
	| 'chain'
	| 'malformed'
	| 'signature'
	| 'root'
	| 'segment'
	| 'missing-head'
	| 'missing-start'
	| 'missing-checkpoint'
	| 'start-order';
export type UnverifiedKind = 'unsealed-start' | 'ended-without-checkpoint' | 'fork';
export type NoticeKind = 'copy-begins-later' | 'copy-begins-mid-segment';
export type VerifyStatus = 'verified' | 'broken' | 'unverified' | 'nothing';

export interface VerifyReport {
	status: VerifyStatus;
	linesRead: number;
	/** Lines with no writer envelope: another program's output. Counted, never leaves. */
	linesNotFromWriter: number;
	starts: number;
	checkpointsVerified: number;
	/** Writer lines no checkpoint covers, the copy's partial head excepted. */
	unsealedLines: number;
	/** Seconds since the epoch, as the signer's clock read it, of the newest verified checkpoint. */
	newestCheckpointTime: number | null;
	/** Per host: lines after its newest checkpoint (not evidence) and that checkpoint's signed time. */
	hosts: { host: string; newestTailLines: number; newestCheckpointTime: number | null }[];
	breaks: { kind: BreakKind; line: number }[];
	unverified: { kind: UnverifiedKind; lines: number }[];
	notices: { kind: NoticeKind; lines: number }[];
}

interface Line {
	/** 1-based position in the copy. */
	at: number;
	text: string;
	record: Record<string, unknown>;
}

type Link = { origin: string; size: number; root: string } | 'none';

interface Start {
	bootId: string;
	lines: Line[];
	host?: string;
	/** The previous start of this host, and the newest checkpoint on the volume, at its start. */
	link?: Link;
	volumeLink?: Link;
	/** No seal_started line in the copy: rotation cut it inside a segment. */
	beganInside: boolean;
	/** Checkpoints whose signature opened, by `origin size root`. */
	held: Set<string>;
	tailLines: number;
	newestTime: number | null;
	sealed: boolean;
}

const ORIGIN = /^budgetpilot\/log\/([0-9a-f-]{36})\/(0|[1-9][0-9]*)$/;
const PREV = /^[0-9a-f]{64}$/;
const ZERO_HASH = '0'.repeat(64);
const WRITER_KEYS = [A.logSchema, A.logBootId, A.logSeq, A.logPrev];

const checkpointKey = (origin: string, size: number, root: string) => `${origin} ${size} ${root}`;

export function verifyLog(text: string, vkeyText: string | readonly string[]): VerifyReport {
	const vkeys: Vkey[] = (typeof vkeyText === 'string' ? [vkeyText] : vkeyText).map(parseVkey);
	const report: VerifyReport = {
		status: 'nothing',
		linesRead: 0,
		linesNotFromWriter: 0,
		starts: 0,
		checkpointsVerified: 0,
		unsealedLines: 0,
		newestCheckpointTime: null,
		hosts: [],
		breaks: [],
		unverified: [],
		notices: []
	};
	const broke = (kind: BreakKind, line: number) => report.breaks.push({ kind, line });

	// Group the writer's lines by start, in order of first appearance.
	const starts = new Map<string, Start>();
	const rows = text.split('\n');
	if (rows.at(-1) === '') rows.pop();
	rows.forEach((row, index) => {
		report.linesRead += 1;
		let record: unknown;
		try {
			record = JSON.parse(row);
		} catch {
			record = undefined;
		}
		if (typeof record !== 'object' || record === null || Array.isArray(record)) {
			report.linesNotFromWriter += 1;
			return;
		}
		const fields = record as Record<string, unknown>;
		// A line claiming the writer's envelope is the writer's (A18): without the chain fields it is
		// malformed, never another program's output.
		const claimed =
			WRITER_KEYS.some((key) => key in fields) ||
			FIELD.eventName in fields ||
			fields[A.serviceName] === SERVICE_NAME;
		if (!claimed) {
			report.linesNotFromWriter += 1;
			return;
		}
		const bootId = fields[A.logBootId];
		if (
			typeof bootId !== 'string' ||
			!Number.isSafeInteger(fields[A.logSeq]) ||
			typeof fields[A.logPrev] !== 'string' ||
			!PREV.test(fields[A.logPrev] as string) ||
			typeof fields[FIELD.eventName] !== 'string'
		) {
			broke('malformed', index + 1);
			return;
		}
		const start = starts.get(bootId) ?? {
			bootId,
			lines: [],
			held: new Set<string>(),
			beganInside: false,
			tailLines: 0,
			newestTime: null,
			sealed: false
		};
		starts.set(bootId, start);
		start.lines.push({ at: index + 1, text: row, record: fields });
	});

	const order = [...starts.values()];
	/** Position in the copy of the last checkpoint that verified, for the tail rule (A13). */
	let lastVerifiedAt = 0;
	report.starts = order.length;
	// A16: rotation cuts only the front of a copy, so once a start that begins at seq 1 has been
	// read, no later start may begin inside a segment.
	order.forEach((start, position) =>
		verifyStart(
			start,
			!order.slice(0, position).some((earlier) => earlier.lines[0].record[A.logSeq] === 1)
		)
	);

	function verifyStart(start: Start, mayBeginInside: boolean) {
		// The keyless chain (#871).
		start.lines.forEach((line, i) => {
			const seq = line.record[A.logSeq] as number;
			const prev = line.record[A.logPrev] as string;
			if (i === 0) {
				if (!mayBeginInside && (seq !== 1 || prev !== ZERO_HASH)) broke('chain', line.at);
				return;
			}
			const before = start.lines[i - 1];
			if (seq !== (before.record[A.logSeq] as number) + 1 || prev !== sha256Hex(before.text)) {
				broke('chain', line.at);
			}
		});

		const startedAt = start.lines.findIndex((l) => l.record[FIELD.eventName] === E.logSealStarted);
		const hasCheckpoint = start.lines.some((l) => l.record[FIELD.eventName] === E.logCheckpoint);
		// Set before the unsealed branch: a cut head with no checkpoint in the copy is still a start
		// whose earlier checkpoints may precede the copy (A17).
		start.beganInside = startedAt < 0 && mayBeginInside;
		if (startedAt < 0 && !hasCheckpoint) {
			report.unverified.push({ kind: 'unsealed-start', lines: start.lines.length });
			report.unsealedLines += start.lines.length;
			return;
		}
		if (startedAt < 0 && !mayBeginInside) {
			broke('missing-head', start.lines[0].at);
			return;
		}
		start.sealed = true;
		if (startedAt > 0) {
			report.unverified.push({ kind: 'unsealed-start', lines: startedAt });
			report.unsealedLines += startedAt;
		}
		if (startedAt >= 0) {
			const started = start.lines[startedAt].record;
			const host = started[A.logSealHost];
			start.host = typeof host === 'string' ? host : undefined;
			start.link = linkOf(
				started[A.logSealPreviousOrigin],
				started[A.logSealPreviousSize],
				started[A.logSealPreviousRoot]
			);
			start.volumeLink = linkOf(
				started[A.logSealVolumePreviousOrigin],
				started[A.logSealVolumePreviousSize],
				started[A.logSealVolumePreviousRoot]
			);
			if (start.host === undefined || start.link === undefined || start.volumeLink === undefined) {
				broke('malformed', start.lines[startedAt].at);
			}
		}

		// Segments: leaf 0 is the seal_started line or the checkpoint that closed the one before.
		let segment: number | undefined = startedAt >= 0 ? 0 : undefined;
		let tree = createMerkleTree();
		let lastCheckpoint = -1;
		const first = Math.max(startedAt, 0);
		for (let i = first; i < start.lines.length; i++) {
			const line = start.lines[i];
			if (line.record[FIELD.eventName] !== E.logCheckpoint) {
				tree.append(Buffer.from(line.text, 'utf8'));
				continue;
			}
			const opened = openWithAnyKey(line.record[A.logCheckpointNote]);
			if ('refused' in opened) {
				broke(opened.refused === 'malformed' ? 'malformed' : 'signature', line.at);
			} else {
				const match = ORIGIN.exec(opened.origin);
				const index = match && match[1] === start.bootId ? Number(match[2]) : undefined;
				start.held.add(checkpointKey(opened.origin, opened.size, opened.root.toString('base64')));
				if (index === undefined || (segment !== undefined && index !== segment)) {
					broke('segment', line.at);
				} else if (segment === undefined) {
					// The copy begins inside this segment: its leaves are not all here.
					report.notices.push({ kind: 'copy-begins-mid-segment', lines: i });
					segment = index;
				} else if (opened.size !== tree.size || !opened.root.equals(tree.root())) {
					broke('root', line.at);
				} else {
					report.checkpointsVerified += 1;
					lastVerifiedAt = Math.max(lastVerifiedAt, line.at);
					start.newestTime = Math.max(start.newestTime ?? 0, opened.timestamp);
				}
			}
			if (segment !== undefined) segment += 1;
			tree = createMerkleTree();
			tree.append(Buffer.from(line.text, 'utf8'));
			lastCheckpoint = i;
		}
		if (lastCheckpoint < 0 && startedAt < 0) {
			// The copy's first start, cut by rotation before its first checkpoint.
			report.notices.push({ kind: 'copy-begins-mid-segment', lines: start.lines.length });
			return;
		}
		// With no checkpoint, every line from seal_started on is the tail: a running start's newest
		// lines, or a start that died before its first checkpoint. Never a notice, which hid them.
		start.tailLines = start.lines.length - 1 - Math.max(lastCheckpoint, startedAt - 1);
		report.unsealedLines += start.tailLines;
	}

	function linkOf(origin: unknown, size: unknown, root: unknown): Link | undefined {
		if (origin === 'none') return 'none';
		return typeof origin === 'string' && typeof size === 'number' && typeof root === 'string'
			? { origin, size, root }
			: undefined;
	}

	function openWithAnyKey(note: unknown): CheckpointFields | { refused: string } {
		if (typeof note !== 'string') return { refused: 'malformed' };
		let refusal: { refused: string } = { refused: 'no-signature-from-key' };
		for (const vkey of vkeys) {
			const opened = openCheckpoint(note, vkey);
			if (!('refused' in opened)) return opened;
			if (opened.refused !== 'no-signature-from-key') refusal = opened;
		}
		return refusal;
	}

	/** The target of a link holds the checkpoint it names, unless the copy begins inside it (A17). */
	function checkHeld(target: Start, key: string, at: number) {
		if (target.beganInside && !target.held.has(key)) {
			report.notices.push({ kind: 'copy-begins-later', lines: 0 });
			return;
		}
		if (!target.held.has(key)) broke('missing-checkpoint', at);
	}

	const targetOf = (link: Exclude<Link, 'none'>) => starts.get(ORIGIN.exec(link.origin)?.[1] ?? '');
	const keyOf = (link: Exclude<Link, 'none'>) => checkpointKey(link.origin, link.size, link.root);

	// Links, followed per host (A10, A12), and through the volume for a host's first start (A14).
	const lastOfHost = new Map<string, Start>();
	// What a link must name: the host's last start that HOLDS a checkpoint. One that died before
	// its first never advanced the state file, so the next start rightly names the one before it.
	const lastSealedOfHost = new Map<string, Start>();
	const linked = new Map<string, Start>();
	order.forEach((start, position) => {
		if (start.host === undefined || start.link === undefined) return;
		const at = start.lines[0].at;
		const firstOfHost = !lastOfHost.has(start.host);
		if (firstOfHost && position > 0 && start.volumeLink !== undefined) {
			const volume = start.volumeLink;
			const target = volume === 'none' ? undefined : targetOf(volume);
			if (volume === 'none') {
				if (order.slice(0, position).some((earlier) => earlier.sealed)) broke('missing-start', at);
			} else if (!target) {
				broke('missing-start', at);
			} else if (order.indexOf(target) > position) {
				broke('start-order', at);
			} else {
				checkHeld(target, keyOf(volume), at);
			}
		}
		const previous = lastSealedOfHost.get(start.host);
		lastOfHost.set(start.host, start);
		if (start.held.size > 0) lastSealedOfHost.set(start.host, start);
		if (start.link === 'none') {
			if (previous) broke('missing-start', at);
			return;
		}
		const key = keyOf(start.link);
		const forked = linked.get(key);
		linked.set(key, start);
		const target = targetOf(start.link);
		const targetPosition = target ? order.indexOf(target) : -1;
		if (!target) {
			if (previous) broke('missing-start', at);
			else report.notices.push({ kind: 'copy-begins-later', lines: 0 });
			return;
		}
		if (previous && target !== previous) {
			if (forked) report.unverified.push({ kind: 'fork', lines: start.lines.length });
			else broke('start-order', at);
			return;
		}
		if (targetPosition > position) {
			broke('start-order', at);
			return;
		}
		checkHeld(target, key, at);
	});
	// A13: a tail is the newest lines only while no verified checkpoint follows its first line in the
	// copy. Otherwise its start ended without its stop checkpoint (killed, out of memory). By position
	// alone: a host tag is an unsigned string anyone can invent.
	for (const start of order) {
		if (!start.sealed || start.tailLines === 0) continue;
		const tailFirstAt = start.lines[start.lines.length - start.tailLines].at;
		if (lastVerifiedAt > tailFirstAt) {
			report.unverified.push({ kind: 'ended-without-checkpoint', lines: start.tailLines });
		}
	}

	for (const [host, start] of lastOfHost) {
		report.hosts.push({
			host,
			newestTailLines: start.tailLines,
			newestCheckpointTime: start.newestTime
		});
	}
	const times = order.map((s) => s.newestTime).filter((t): t is number => t !== null);
	report.newestCheckpointTime = times.length > 0 ? Math.max(...times) : null;
	report.status =
		report.breaks.length > 0
			? 'broken'
			: report.checkpointsVerified === 0
				? 'nothing'
				: report.unverified.length > 0
					? 'unverified'
					: 'verified';
	return report;
}
