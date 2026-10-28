import { describe, expect, it } from 'vitest';
import { NAMES_BEFORE_THE_BP_PREFIX, SETTING_GROUPS, SETTINGS, type Setting } from './settings';

const entries = Object.entries(SETTINGS) as [string, Setting][];

/**
 * The registry's own shape: what a reader of the reference page and every boot check rely on, and
 * what the type system cannot say. One value per test, so every figure is shown whichever is red.
 */
describe('the settings registry', () => {
	it('declares every setting it is asked about', () => {
		// The absolute figure beside every « no offenders » below: a registry that lost its entries
		// would satisfy each of them.
		expect(entries.length).toBe(55);
	});

	// R13 (#841): a new name starts with `BP_`, and the names that existed before the ruling are
	// frozen rather than renamed. Break-checked: an entry `NEW_UNPREFIXED` added to SETTINGS (a new
	// name outside the prefix versus inside it) lists it here.
	it('names every setting added after R13 with the BP_ prefix', () => {
		const unprefixed = entries
			.map(([name]) => name)
			.filter((name) => !name.startsWith('BP_') && !NAMES_BEFORE_THE_BP_PREFIX.includes(name))
			// The file form of a frozen name (owner, 2026-10-28, #826/#1099): the docker-library
			// `<NAME>_FILE` convention, which collides with nothing its base name does not.
			.filter((name) => !(name.endsWith('_FILE') && NAMES_BEFORE_THE_BP_PREFIX.includes(name.slice(0, -5))));
		expect(unprefixed).toStrictEqual([]);
	});

	// #826/#1099, owner 2026-10-28: the file form of a frozen name is that name plus `_FILE`, the
	// docker-library convention operators copy, and it collides with nothing the base name does not
	// already collide with. A rule, not four additions to the frozen list. Separates a registry that
	// declares the file forms from one that does not.
	it('declares the file form of each secret the boot reads from a file', () => {
		const fileForms = entries.map(([name]) => name).filter((name) => name.endsWith('_FILE'));
		expect(fileForms).toStrictEqual([
			'TOTP_ENCRYPTION_KEY_FILE',
			'RATE_LIMIT_HASH_SECRET_FILE',
			'BOOTSTRAP_TOKEN_FILE',
			'DATABASE_PASSWORD_FILE'
		]);
	});

	it('keeps the frozen list to names the registry still declares', () => {
		const stale = NAMES_BEFORE_THE_BP_PREFIX.filter((name) => !(name in SETTINGS));
		expect(stale).toStrictEqual([]);
	});

	// AGENTS.md, « Code style »: a number an operator may move has a default and a hard ceiling. A
	// default outside its own range would make the app refuse to start with nothing configured.
	// Break-checked: `SESSION_TTL_DAYS.default` set to 401 (a default above its ceiling versus
	// inside) lists it.
	it('gives every whole-number setting a default inside a range of safe integers', () => {
		const malformed = entries
			.filter(([, setting]) => setting.kind === 'integer')
			.filter(([, setting]) => {
				if (setting.kind !== 'integer') return false;
				return !(
					Number.isSafeInteger(setting.min) &&
					Number.isSafeInteger(setting.max) &&
					setting.min >= 1 &&
					setting.min <= setting.default &&
					setting.default <= setting.max &&
					setting.ceiling.length > 0
				);
			})
			.map(([name]) => name);
		expect(malformed).toStrictEqual([]);
	});

	it('gives every choice a default that is one of its values', () => {
		const malformed = entries
			.filter(
				([, setting]) => setting.kind === 'choice' && !setting.values.includes(setting.default)
			)
			.map(([name]) => name);
		expect(malformed).toStrictEqual([]);
	});

	it('files every setting under a declared group, with a sentence and a page', () => {
		const malformed = entries
			.filter(
				([, setting]) =>
					!SETTING_GROUPS.includes(setting.group) ||
					!/^[A-Z].*\.$/.test(setting.summary) ||
					!/^[a-z/-]+\.md(#[a-z0-9_-]+)?$/.test(setting.page)
			)
			.map(([name]) => name);
		expect(malformed).toStrictEqual([]);
	});
});
