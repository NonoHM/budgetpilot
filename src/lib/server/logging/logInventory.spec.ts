import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from './events';
import { ATTRIBUTE as A, FIELD } from './names';

/**
 * The log inventory (`docs/logging.md`, ASVS v5.0.0-16.1.1) against the registry it describes.
 * The page's « Every event » section must list every event of REGISTRY, in its order, each with its
 * severity, whether it is summarised, its fixed sentence, and every attribute with its level, and
 * nothing else. A new event or field added to the code without its row fails here, and so does a row
 * left on the page after its event was removed.
 */

const page = readFileSync(join(process.cwd(), 'docs/logging.md'), 'utf8');

interface DocumentedEvent {
	severity: string;
	flood: boolean;
	body: string;
	attributes: Record<string, string>;
}

function documentedEvents(): Map<string, DocumentedEvent> {
	const section = page.split('\n## Every event\n')[1]?.split('\n---\n')[0] ?? '';
	const events = new Map<string, DocumentedEvent>();
	for (const block of section.split('\n### ').slice(1)) {
		const name = /^`([^`]+)`/.exec(block)?.[1] ?? '';
		const severity = /Severity (\w+)\./.exec(block)?.[1] ?? '';
		const body = /^> (.*)$/m.exec(block)?.[1] ?? '';
		const attributes: Record<string, string> = {};
		// Prettier pads table cells, so either side of each separator may carry spaces, and a level
		// may be two words (« Not classified »).
		for (const [, attribute, level] of block.matchAll(
			/^\| `([^`]+)` +\| ([A-Za-z]+(?: [a-z]+)?) +\|$/gm
		)) {
			attributes[attribute] = level;
		}
		events.set(name, {
			severity,
			flood: block.includes('Summarised when repeated.'),
			body,
			attributes
		});
	}
	return events;
}

describe('docs/logging.md, « Every event »', () => {
	it('lists exactly the registry events, in the registry order', () => {
		// The absolute figure beside the comparison, so an empty parse cannot pass as a match.
		const documented = [...documentedEvents().keys()];
		expect(documented.length).toBe(Object.keys(REGISTRY).length);
		expect(documented).toEqual(Object.keys(REGISTRY));
	});

	it('gives each event its severity, its summarising, its sentence and every attribute with its level', () => {
		const documented = documentedEvents();
		const mismatches = Object.entries(REGISTRY).filter(([name, spec]) => {
			const row = documented.get(name);
			return (
				!row ||
				row.severity !== spec.severity ||
				row.flood !== spec.flood ||
				row.body !== spec.body ||
				JSON.stringify(row.attributes) !== JSON.stringify(spec.attributes)
			);
		});
		expect(mismatches.map(([name]) => name)).toEqual([]);
	});

	it('reads attribute rows at all: the page holds as many as the registry declares', () => {
		const declared = Object.values(REGISTRY).reduce(
			(total, spec) => total + Object.keys(spec.attributes).length,
			0
		);
		const documented = [...documentedEvents().values()].reduce(
			(total, event) => total + Object.keys(event.attributes).length,
			0
		);
		expect([declared > 0, documented]).toEqual([true, declared]);
	});
});

describe('the levels a log field may hold (docs/explanation/data-classification.md)', () => {
	// Text the application does not choose cannot be given a level by the application: rule 2 of
	// the classification gives free text the level of what it is about, and nobody knows what a
	// dependency will print. So it is « not classified », like the output of prisma migrate deploy,
	// and only that one field may say so (contradiction pass on L2, item 6).
	it('marks budgetpilot.console.text, and only it, as not classified', () => {
		const unclassified = Object.values(REGISTRY).flatMap((spec) =>
			Object.entries(spec.attributes)
				.filter(([, level]) => level === 'Not classified')
				.map(([attribute]) => attribute)
		);
		expect(unclassified).toEqual([A.consoleText]);
	});

	it('holds no Secret, Financial or Personal field anywhere', () => {
		const levels = new Set(
			Object.values(REGISTRY).flatMap((spec) => Object.values(spec.attributes) as string[])
		);
		expect([...levels].sort()).toEqual(['Not classified', 'Operational', 'Pseudonymous']);
	});

	it('gives Pseudonymous to the three keyed hashes of pseudonym.ts, and to nothing else', () => {
		const pseudonymous = new Set(
			Object.values(REGISTRY).flatMap((spec) =>
				Object.entries(spec.attributes)
					.filter(([, level]) => level === 'Pseudonymous')
					.map(([attribute]) => attribute)
			)
		);
		expect([...pseudonymous].sort()).toEqual(
			[A.clientPseudonym, A.clientSubnetPseudonym, A.userPseudonym].sort()
		);
	});
});

describe('docs/logging.md, the envelope', () => {
	it('names every field the writer puts on every line', () => {
		const envelope = [
			FIELD.timestamp,
			FIELD.severityText,
			FIELD.severityNumber,
			FIELD.eventName,
			FIELD.body,
			FIELD.traceId,
			A.serviceName,
			A.httpMethod,
			A.httpRoute,
			A.logSchema,
			A.logBootId,
			A.logSeq,
			A.logPrev
		];
		expect(envelope.filter((field) => !page.includes(`\`${field}\``))).toEqual([]);
	});
});

/**
 * « Every field » and « What to do » (docs/logging.md): the same contract as « Every event », for the
 * names themselves and for the events an operator has to act on. A name added to names.ts without a
 * row fails, and so does a row left after its name was removed.
 */
function section(heading: string): string {
	return page.split(`\n## ${heading}\n`)[1]?.split(/\n## |\n---\n/)[0] ?? '';
}

/** The cells after the first of every table row of a section whose first cell is a code span. */
function tableRows(heading: string): Map<string, string[]> {
	const rows = new Map<string, string[]>();
	for (const line of section(heading).split('\n')) {
		const match = /^\| `([^`]+)`(?:, `[^`]+`)* *\|(.*)\|$/.exec(line);
		if (!match) continue;
		rows.set(
			match[1],
			match[2].split(/(?<!\\)\|/).map((cell) => cell.trim())
		);
	}
	return rows;
}

describe('docs/logging.md, « Every field »', () => {
	const declared: string[] = [...Object.values(FIELD), ...Object.values(A)];

	it('has one row for every field and attribute of names.ts, and no other', () => {
		const documented = [...tableRows('Every field').keys()];
		// The absolute figure beside the comparison, so an empty parse cannot pass as a match.
		expect(documented.length).toBe(declared.length);
		expect(documented.sort()).toEqual([...declared].sort());
	});

	it('fills every column of every row: meaning, type, values, example and level', () => {
		const thin = [...tableRows('Every field')]
			.filter(([, cells]) => cells.length !== 5 || cells.some((cell) => cell === ''))
			.map(([name]) => name);
		expect(thin).toEqual([]);
	});

	it('gives each row the level the registry gives that attribute', () => {
		const levels = new Map<string, Set<string>>();
		for (const spec of Object.values(REGISTRY)) {
			for (const [attribute, level] of Object.entries(spec.attributes)) {
				levels.set(attribute, (levels.get(attribute) ?? new Set()).add(level as string));
			}
		}
		const wrong = [...tableRows('Every field')]
			.filter(([name, cells]) => {
				const expected = [...(levels.get(name) ?? new Set(['Operational']))];
				return expected.length !== 1 || cells[4] !== expected[0];
			})
			.map(([name]) => name);
		expect(wrong).toEqual([]);
	});
});

describe('docs/logging.md, « What to do »', () => {
	it('has one row for every WARN, ERROR and FATAL event, and no other', () => {
		const needsAction = Object.entries(REGISTRY)
			.filter(([, spec]) => ['WARN', 'ERROR', 'FATAL'].includes(spec.severity))
			.map(([name]) => name);
		const documented = [...tableRows('What to do').keys()];
		expect(needsAction.length).toBeGreaterThan(0);
		expect(documented.sort()).toEqual([...needsAction].sort());
	});

	it('says something in every row', () => {
		const empty = [...tableRows('What to do')]
			.filter(([, cells]) => cells.length !== 1 || cells[0].length < 10)
			.map(([name]) => name);
		expect(empty).toEqual([]);
	});
});
