import { describe, expect, it } from 'vitest';
import { installConsoleBridge, type LogEvent } from './index';
import { ATTRIBUTE as A, EVENT as E } from './names';

/**
 * The console bridge: what a dependency prints through the console becomes one escaped, capped
 * `budgetpilot.console.output` event. A fake console and a recording writer, so nothing is printed
 * and every event is read back whole.
 */

function fakeConsole(): Console {
	const untouched = () => {
		throw new Error('a console method the bridge did not wrap was called');
	};
	return {
		log: untouched,
		info: untouched,
		debug: untouched,
		warn: untouched,
		error: untouched,
		trace: untouched,
		dir: untouched
	} as unknown as Console;
}

describe('installConsoleBridge', () => {
	it('wraps every printing method, console.dir included (contradiction pass on L2, item 7)', () => {
		const written: LogEvent[] = [];
		const target = fakeConsole();
		installConsoleBridge(target, (event) => written.push(event));

		target.log('a %s', 'line');
		target.info('i');
		target.debug('d');
		target.warn('w');
		target.error('e');
		target.trace('t');
		target.dir({ shape: 1 });

		expect(written).toEqual([
			{
				event: E.consoleOutput,
				attributes: { [A.consoleMethod]: 'log', [A.consoleText]: 'a line' }
			},
			{ event: E.consoleOutput, attributes: { [A.consoleMethod]: 'info', [A.consoleText]: 'i' } },
			{ event: E.consoleOutput, attributes: { [A.consoleMethod]: 'debug', [A.consoleText]: 'd' } },
			{ event: E.consoleOutput, attributes: { [A.consoleMethod]: 'warn', [A.consoleText]: 'w' } },
			{ event: E.consoleOutput, attributes: { [A.consoleMethod]: 'error', [A.consoleText]: 'e' } },
			{ event: E.consoleOutput, attributes: { [A.consoleMethod]: 'trace', [A.consoleText]: 't' } },
			{
				event: E.consoleOutput,
				attributes: { [A.consoleMethod]: 'dir', [A.consoleText]: '{ shape: 1 }' }
			}
		]);
	});
});
