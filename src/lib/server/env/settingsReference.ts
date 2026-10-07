import { SETTING_GROUPS, SETTINGS, type Setting, type SettingTier } from './settings';

/**
 * Renders `docs/configuration-reference.md` from the settings registry (R14). The page is generated
 * so that it cannot drift from what the app reads: `settingsReference.spec.ts` compares the committed
 * page with this output and fails on any difference, and
 * `npx vitest run src/lib/server/env/settingsReference.spec.ts -u` rewrites it.
 *
 * Plain markdown, one table per group, in the registry's order. No value of a secret is ever
 * written; a secret's row says how to generate one.
 */

const TIER_LABEL: Record<SettingTier, string> = {
	essential: 'Set on every install',
	common: 'Common',
	advanced: 'Advanced'
};

const READER_NOTE = {
	app: '',
	'adapter-node': ' Read by the SvelteKit Node adapter, not by the app.',
	compose: ' Read by Docker Compose, not by the app.'
} as const;

/** Backslashes first, then pipes: a pipe escaped after an unescaped backslash would split the cell. */
export const escapeTableCell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const cell = escapeTableCell;
const code = (text: string) => `\`${text}\``;
const number = (value: number) => value.toLocaleString('en-US');

function accepted(setting: Setting): string {
	switch (setting.kind) {
		case 'integer':
			return `${number(setting.min)} to ${number(setting.max)} ${setting.unit}. Outside that range, or not written in the digits 0 to 9, the app refuses to start.`;
		case 'choice':
			return `${setting.values.map(code).join(', ')}. Any other value ${setting.otherwise === 'refused' ? 'stops the app at startup' : `is ${setting.otherwise}`}.`;
		case 'text':
			return `${setting.format[0].toUpperCase()}${setting.format.slice(1)}.`;
	}
}

function defaultOf(setting: Setting): string {
	if (setting.kind === 'integer') return code(String(setting.default));
	if (setting.kind === 'choice') return code(setting.default);
	return setting.default === undefined ? 'none' : setting.default;
}

function row(name: string, setting: Setting): string {
	const secret = setting.secret ? ' **Secret:** never logged, never shown.' : '';
	const ceiling = setting.kind === 'integer' ? ` Why the ceiling: ${setting.ceiling}` : '';
	return `| ${code(name)} | ${cell(setting.summary + secret + READER_NOTE[setting.readBy])} | ${cell(defaultOf(setting))} | ${cell(accepted(setting) + ceiling)} | ${TIER_LABEL[setting.tier]} | [More](${setting.page}) |`;
}

export function renderSettingsReference(): string {
	const entries = Object.entries(SETTINGS) as [string, Setting][];
	const sections = SETTING_GROUPS.map((group) => {
		const rows = entries.filter(([, setting]) => setting.group === group);
		return [
			`## ${group}`,
			'',
			'| Setting | What it does | Default | Accepted values | Tier | Guide |',
			'| --- | --- | --- | --- | --- | --- |',
			...rows.map(([name, setting]) => row(name, setting)),
			''
		].join('\n');
	});

	return [
		'# Configuration reference',
		'',
		'For operators. Every environment variable BudgetPilot reads, with its default and the values it accepts.',
		'For what to change and why, read [Configuration](configuration.md) first.',
		'',
		'<!-- Generated from src/lib/server/env/settings.ts. Do not edit by hand: change the registry, then run',
		'     npx vitest run src/lib/server/env/settingsReference.spec.ts -u -->',
		'',
		'Set these in the `.env` file next to your compose file, then restart. A whole number is written in the',
		'digits 0 to 9 only: `0x10`, `1e3`, `12.0` and `1_000` are refused rather than read as a number you did',
		'not write. An empty value is the same as leaving the variable out.',
		'',
		'**Tier** says who needs it: « Set on every install » is the short list a new install must get right;',
		'« Advanced » settings are safe to leave out.',
		'',
		...sections
	].join('\n');
}
