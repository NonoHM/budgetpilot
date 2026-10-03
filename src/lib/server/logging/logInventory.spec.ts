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
		// Prettier pads table cells, so either side of each separator may carry spaces.
		for (const [, attribute, level] of block.matchAll(/^\| `([^`]+)` +\| (\w+) +\|$/gm)) {
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
