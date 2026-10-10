import {
	DEFAULT_LOG_LEVEL,
	DEFAULT_SECURITY_LOG,
	LOG_LEVELS,
	SECURITY_LOG_VALUES
} from '../logging/settings.ts';

/**
 * THE SETTINGS REGISTRY (R14 of the 1.3 plan, ruled on #841): every environment variable an operator
 * may set, declared once, with what the documentation and the boot checks need to know about it.
 *
 * **Why one table.** Before it, a setting was spelled three times (the code reading it,
 * `.env.example` and `docs/configuration.md`), and the census on 2026-10-07 found the three had
 * drifted: 22 names read under `src/` were missing from the configuration page, and six numbers
 * still accepted `0x10` or clamped silently (#754). Now:
 * - the reference page `docs/configuration-reference.md` is GENERATED from this table
 *   (`settingsReference.spec.ts` fails when the committed page differs);
 * - `settingsDrift.spec.ts` fails when production code reads a name this table does not declare,
 *   when an entry nothing reads, or when `.env.example` carries a key that is not here;
 * - every `integer` entry is read through `readIntegerSetting`, which refuses rather than clamps.
 *
 * **What it is not.** It is not a loader: it holds no value and reads no environment. Each reader
 * still lives beside the code that uses the value, and asks this table for its bounds. A leaf
 * module on purpose, importing nothing but the logger's two domains, so the five bound modules can
 * import their numbers from here without a cycle and without pulling Prisma into anything that only
 * wants a default.
 *
 * **Adding a setting.** A new name starts with `BP_` (R13: an environment variable in another
 * tool's reserved prefix is an input to that tool); `settings.spec.ts` enforces it against the
 * names that existed before R13. A number gets a default, a floor and a hard ceiling, and the
 * ceiling sentence says what raising it past the ceiling would cost.
 */

/** Who must read about it: `essential` names are set on every install, `advanced` rarely. */
export type SettingTier = 'essential' | 'common' | 'advanced';

/** The heading the reference page files the setting under, in this order. */
export const SETTING_GROUPS = [
	'Instance',
	'Secrets',
	'Accounts and sessions',
	'Database',
	'Reverse proxy',
	'Uploads and imports',
	'Bank sync',
	'AI insights',
	'Logging',
	'Server process'
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/**
 * Who reads the variable. Only `app` entries must be found in this repository's code by the drift
 * test; the others are read by SvelteKit's Node adapter, by Docker Compose, or by the image.
 */
export type SettingReader = 'app' | 'adapter-node' | 'compose';

type SettingBase = {
	tier: SettingTier;
	group: SettingGroup;
	readBy: SettingReader;
	/** One sentence for the reference page: what it changes, in the operator's words. */
	summary: string;
	/** The page that explains it, relative to `docs/`. */
	page: string;
	/** A secret is never logged, never echoed in a refusal, and never shown with its value. */
	secret?: true;
};

export type IntegerSetting = SettingBase & {
	kind: 'integer';
	default: number;
	/** The smallest value accepted. Below it the app refuses to start. */
	min: number;
	/** The hard ceiling. Above it the app refuses to start rather than clamping (AGENTS.md). */
	max: number;
	/** What one unit is, in the plural: `days`, `milliseconds`, `columns`. */
	unit: string;
	/** Why the ceiling is where it is, quoted in the refusal. */
	ceiling: string;
};

export type ChoiceSetting = SettingBase & {
	kind: 'choice';
	values: readonly string[];
	default: string;
	/**
	 * What a value outside `values` does today. `refused` is the target for every choice; the others
	 * describe current behaviour truthfully, so the reference page never claims a refusal that does
	 * not happen.
	 */
	otherwise: 'refused' | `treated as ${string}`;
};

export type TextSetting = SettingBase & {
	kind: 'text';
	/** What a valid value looks like, for the reference page. */
	format: string;
	/** The default, as an operator would write it, or a sentence when it is not a literal. */
	default?: string;
};

export type Setting = IntegerSetting | ChoiceSetting | TextSetting;

export const SETTINGS = {
	// ── Instance ────────────────────────────────────────────────────────────────────────────────
	ORIGIN: {
		kind: 'text',
		tier: 'essential',
		group: 'Instance',
		readBy: 'adapter-node',
		format: 'the exact URL typed in the browser, without a trailing slash',
		default: 'http://localhost:<APP_PORT> under Docker Compose',
		summary:
			'The address people use to reach the app. Form submissions from any other origin are refused.',
		page: 'configuration.md#origin-has-to-be-exact'
	},
	PUBLIC_INSTANCE: {
		kind: 'choice',
		tier: 'essential',
		group: 'Instance',
		readBy: 'app',
		values: ['true', 'false'],
		default: 'true',
		otherwise: 'treated as true',
		summary:
			'Whether session cookies are sent only over HTTPS. Set false only for a local network served over plain http.',
		page: 'configuration.md#public_instance-and-the-session-cookie'
	},
	REGISTRATION_MODE: {
		kind: 'choice',
		tier: 'common',
		group: 'Instance',
		readBy: 'app',
		values: ['admin_only', 'open'],
		default: 'admin_only',
		otherwise: 'treated as admin_only',
		summary:
			'Who may create an account: only an administrator through an invitation, or anyone who reaches the sign-up page.',
		page: 'configuration.md#who-can-create-an-account'
	},
	APP_PORT: {
		kind: 'text',
		tier: 'common',
		group: 'Instance',
		readBy: 'compose',
		format: 'a TCP port number',
		default: '3000',
		summary: 'The port Docker Compose publishes the app on, on the host.',
		page: 'configuration.md'
	},

	// ── Secrets ─────────────────────────────────────────────────────────────────────────────────
	TOTP_ENCRYPTION_KEY: {
		kind: 'text',
		tier: 'essential',
		group: 'Secrets',
		readBy: 'app',
		secret: true,
		format: '64 hexadecimal characters (`openssl rand -hex 32`)',
		summary:
			'Encrypts every two-factor secret at rest. Changing it locks every user with two-factor out.',
		page: 'configuration.md#the-three-secrets'
	},
	RATE_LIMIT_HASH_SECRET: {
		kind: 'text',
		tier: 'essential',
		group: 'Secrets',
		readBy: 'app',
		secret: true,
		format: '64 hexadecimal characters (`openssl rand -hex 32`)',
		summary:
			'Keys the hashes that stand in for addresses and account names in rate limits and logs.',
		page: 'configuration.md#the-three-secrets'
	},
	BOOTSTRAP_TOKEN: {
		kind: 'text',
		tier: 'essential',
		group: 'Secrets',
		readBy: 'app',
		secret: true,
		format: 'any string (`openssl rand -base64 32`)',
		summary:
			'Required to create the first administrator account. May be left blank once one exists.',
		page: 'configuration.md#the-three-secrets'
	},
	BP_STRICT_SECRET_FILES: {
		kind: 'choice',
		tier: 'advanced',
		group: 'Secrets',
		readBy: 'app',
		values: ['off', 'on'],
		default: 'off',
		otherwise: 'refused',
		summary:
			'When on, the app refuses to start if a file holding a secret can be read or replaced by another account. When off, it only warns.',
		page: 'configuration.md#refusing-to-start-on-an-exposed-secret-file'
	},

	// ── Accounts and sessions ───────────────────────────────────────────────────────────────────
	PASSWORD_HASH_COST: {
		kind: 'integer',
		tier: 'common',
		group: 'Accounts and sessions',
		readBy: 'app',
		default: 12,
		min: 12,
		max: 15,
		unit: '(bcrypt cost, each step doubles the time)',
		ceiling:
			'Each step doubles the time every sign-in takes: measured at 160 ms at 12 and 1.3 s at 15, so a higher value turns the sign-in form into a way to exhaust the server.',
		summary:
			'The bcrypt work factor for stored passwords. Raising it slows every sign-in, on purpose.',
		page: 'configuration.md#passwords-and-sessions'
	},
	SESSION_TTL_DAYS: {
		kind: 'integer',
		tier: 'common',
		group: 'Accounts and sessions',
		readBy: 'app',
		default: 30,
		min: 1,
		max: 400,
		unit: 'days',
		ceiling:
			'Chrome and Firefox keep a cookie for at most 400 days whatever the server asks, the limit the IETF cookie draft recommends, so a longer lifetime mostly keeps a copied cookie usable.',
		summary: 'How long a sign-in lasts before the user must sign in again.',
		page: 'configuration.md#passwords-and-sessions'
	},
	BP_SESSION_IDLE_TIMEOUT_HOURS: {
		kind: 'integer',
		tier: 'common',
		group: 'Accounts and sessions',
		readBy: 'app',
		default: 168,
		min: 1,
		max: 720,
		unit: 'hours',
		ceiling:
			'720 hours is 30 days, the default sign-in lifetime, so a longer inactivity timeout would never end a session before SESSION_TTL_DAYS does at its default.',
		summary: 'How long a sign-in can go unused before it ends, within its lifetime.',
		page: 'configuration.md#passwords-and-sessions'
	},
	INVITATION_TTL_HOURS: {
		kind: 'integer',
		tier: 'common',
		group: 'Accounts and sessions',
		readBy: 'app',
		default: 72,
		min: 1,
		max: 720,
		unit: 'hours',
		ceiling:
			'An invitation link is a credential anyone holding it can use. 720 hours is 30 days, the longest validity NIST SP 800-63B-4 gives a recovery code, for one sent by post abroad.',
		summary: 'How long an invitation link stays valid.',
		page: 'configuration.md#passwords-and-sessions'
	},
	BP_RATE_LIMIT_IPV6_PREFIX: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Accounts and sessions',
		readBy: 'app',
		default: 56,
		min: 32,
		max: 64,
		unit: 'bits',
		ceiling:
			'An end site is given a /64 at the least, so above 64 one subscriber holds more than one counter, and choosing a new address resets the per-address limit.',
		summary:
			'How many leading bits of an IPv6 address the per-address rate limits count as one client.',
		page: 'configuration.md#how-attempts-are-counted-per-address'
	},

	// ── Database ────────────────────────────────────────────────────────────────────────────────
	DATABASE_PROVIDER: {
		kind: 'choice',
		tier: 'essential',
		group: 'Database',
		readBy: 'app',
		values: ['sqlite', 'postgresql', 'postgres', 'mysql', 'mariadb'],
		default: 'sqlite',
		otherwise: 'refused',
		summary: 'Which database engine to use.',
		page: 'configuration.md#database'
	},
	DATABASE_URL: {
		kind: 'text',
		tier: 'essential',
		group: 'Database',
		readBy: 'app',
		secret: true,
		format: 'a connection string whose scheme matches DATABASE_PROVIDER',
		default: 'file:/data/budgetpilot.db in the image',
		summary: 'Where the database is. With a server engine it carries the password.',
		page: 'configuration.md#database'
	},
	DATABASE_PASSWORD: {
		kind: 'text',
		tier: 'common',
		group: 'Database',
		readBy: 'compose',
		secret: true,
		format: '64 hexadecimal characters (`openssl rand -hex 32`)',
		summary:
			'Password of the database server the PostgreSQL and MySQL Compose overlays start. SQLite ignores it.',
		page: 'database-providers.md'
	},

	// ── Reverse proxy ───────────────────────────────────────────────────────────────────────────
	TRUSTED_PROXIES: {
		kind: 'text',
		tier: 'common',
		group: 'Reverse proxy',
		readBy: 'app',
		format: 'comma-separated IP addresses or CIDR ranges',
		summary:
			'The proxies whose X-Forwarded-For header is believed. Unset, the connecting address is the client.',
		page: 'reverse-proxy.md'
	},
	ADDRESS_HEADER: {
		kind: 'text',
		tier: 'advanced',
		group: 'Reverse proxy',
		readBy: 'app',
		format: 'must stay unset',
		summary:
			'Read by the Node adapter, which would trust the header from anyone. The app refuses to start when it is set; use TRUSTED_PROXIES.',
		page: 'reverse-proxy.md'
	},
	XFF_DEPTH: {
		kind: 'text',
		tier: 'advanced',
		group: 'Reverse proxy',
		readBy: 'app',
		format: 'must stay unset',
		summary:
			'Read by the Node adapter together with ADDRESS_HEADER. The app refuses to start when it is set; use TRUSTED_PROXIES.',
		page: 'reverse-proxy.md'
	},

	// ── Uploads and imports ─────────────────────────────────────────────────────────────────────
	BODY_SIZE_LIMIT: {
		kind: 'text',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'adapter-node',
		format: 'a number of bytes',
		default: '21000000 in the Compose files',
		summary:
			'The largest request body accepted, sized for a backup restore. It does not change the statement import limit.',
		page: 'configuration.md#upload-size'
	},
	IMPORT_XLSX_MAX_UNCOMPRESSED_MB: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'app',
		default: 8,
		min: 1,
		max: 32,
		unit: 'megabytes',
		ceiling:
			'A workbook expanding to 32 MB takes about a second to parse and holds the server while it does (#254).',
		summary: 'How much an uploaded .xlsx file may expand to when unpacked.',
		page: 'configuration.md#upload-size'
	},
	BACKUP_MAX_JSON_NODES: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'app',
		default: 2_000_000,
		min: 1,
		max: 4_000_000,
		unit: 'values',
		ceiling:
			'A backup carrying 4,000,000 values already costs about 214 MB of memory to parse, before any validation runs (#276).',
		summary: 'How many separate values a restored backup may contain.',
		page: 'configuration.md#backup-size'
	},
	CSV_MAX_COLUMNS: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'app',
		default: 512,
		min: 1,
		max: 4_096,
		unit: 'columns',
		ceiling:
			'The column count multiplies the cost of every row the parser reads, and no bank export comes near it.',
		summary: 'How many columns an imported statement may have.',
		page: 'configuration.md#how-many-columns-a-statement-may-have'
	},
	COLUMN_MAPPINGS_PER_USER: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'app',
		default: 50,
		min: 1,
		max: 500,
		unit: 'mappings',
		ceiling:
			'Every saved mapping is compared against each upload, so the count bounds the work one upload causes.',
		summary: 'How many saved column mappings one account may keep.',
		page: 'configuration.md#how-many-column-mappings-one-account-may-keep'
	},
	IMPORT_RATE_LIMIT_MAX_ATTEMPTS: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Uploads and imports',
		readBy: 'app',
		default: 60,
		min: 1,
		max: 240,
		unit: 'uploads per 15 minutes',
		ceiling:
			'Above 240 the limit no longer stops one account from keeping the parser busy for everyone.',
		summary: 'How many statement uploads one account may make in 15 minutes.',
		page: 'configuration.md#how-many-uploads-one-account-may-make'
	},

	// ── Bank sync ───────────────────────────────────────────────────────────────────────────────
	BANK_SYNC_ENABLED: {
		kind: 'choice',
		tier: 'common',
		group: 'Bank sync',
		readBy: 'app',
		values: ['false', 'true'],
		default: 'false',
		otherwise: 'treated as false',
		summary: 'Turns on bank synchronisation through Enable Banking.',
		page: 'bank-sync.md'
	},
	BANK_SYNC_ALLOWED_HOSTS: {
		kind: 'text',
		tier: 'advanced',
		group: 'Bank sync',
		readBy: 'app',
		format: 'comma-separated host names; a value replaces the default',
		default: 'api.enablebanking.com',
		summary: 'The only hosts bank synchronisation may call, always over https.',
		page: 'bank-sync.md'
	},
	BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: {
		kind: 'text',
		tier: 'common',
		group: 'Bank sync',
		readBy: 'app',
		format: 'comma-separated origins, exactly as registered with Enable Banking',
		summary: 'The origins a bank consent may return to. Unset, no bank connection can start.',
		page: 'bank-sync.md'
	},
	BANK_SYNC_FIRST_LOOKBACK_DAYS: {
		kind: 'integer',
		tier: 'advanced',
		group: 'Bank sync',
		readBy: 'app',
		default: 90,
		min: 1,
		max: 3650,
		unit: 'days',
		ceiling: 'Ten years is beyond what any bank serves through PSD2.',
		summary: 'How far back a first synchronisation asks the bank for transactions.',
		page: 'bank-sync.md'
	},
	ENABLE_BANKING_APP_ID: {
		kind: 'text',
		tier: 'common',
		group: 'Bank sync',
		readBy: 'app',
		format: 'the application id from the Enable Banking Control Panel',
		summary: 'Identifies this instance to Enable Banking.',
		page: 'bank-sync.md'
	},
	ENABLE_BANKING_PRIVATE_KEY: {
		kind: 'text',
		tier: 'common',
		group: 'Bank sync',
		readBy: 'app',
		secret: true,
		format: 'a PEM private key, newlines written as \\n; set this or the _PATH form, never both',
		summary: 'The private key that signs requests to Enable Banking, inline.',
		page: 'bank-sync.md'
	},
	ENABLE_BANKING_PRIVATE_KEY_PATH: {
		kind: 'text',
		tier: 'common',
		group: 'Bank sync',
		readBy: 'app',
		format: 'a path to a PEM file, readable by the app; set this or the inline form, never both',
		summary: 'The private key that signs requests to Enable Banking, as a file.',
		page: 'bank-sync.md'
	},
	ENABLE_BANKING_BASE_URL: {
		kind: 'text',
		tier: 'advanced',
		group: 'Bank sync',
		readBy: 'app',
		format: 'an https URL whose host is in BANK_SYNC_ALLOWED_HOSTS',
		default: 'https://api.enablebanking.com',
		summary: 'The Enable Banking API address.',
		page: 'bank-sync.md'
	},

	// ── AI insights ─────────────────────────────────────────────────────────────────────────────
	LLM_ENABLED: {
		kind: 'choice',
		tier: 'common',
		group: 'AI insights',
		readBy: 'app',
		values: ['false', 'true'],
		default: 'false',
		otherwise: 'treated as false',
		summary: 'Turns on the optional insights written by a local model.',
		page: 'ai-insights.md'
	},
	LLM_PROVIDER: {
		kind: 'choice',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		values: ['ollama'],
		default: 'ollama',
		otherwise: 'treated as insights off',
		summary: 'Which model server to call. Only Ollama exists; any other value turns insights off.',
		page: 'reference/ai-model.md'
	},
	LLM_BASE_URL: {
		kind: 'text',
		tier: 'common',
		group: 'AI insights',
		readBy: 'app',
		format: 'a URL whose host is in LLM_ALLOWED_HOSTS',
		default: 'http://127.0.0.1:11434',
		summary: 'Where the model server listens.',
		page: 'ai-insights.md'
	},
	LLM_MODEL: {
		kind: 'text',
		tier: 'common',
		group: 'AI insights',
		readBy: 'app',
		format: 'an Ollama model name',
		default: 'qwen2.5:0.5b',
		summary: 'Which model writes the insights.',
		page: 'ai-insights.md'
	},
	LLM_TIMEOUT_MS: {
		kind: 'integer',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		default: 45_000,
		min: 1,
		max: 600_000,
		unit: 'milliseconds',
		ceiling:
			'Ten minutes is longer than any proxy or browser keeps a request open, so a longer wait would never reach the reader.',
		summary: 'How long to wait for the model once its server has answered, loading included.',
		page: 'ai-insights.md'
	},
	LLM_CONNECT_TIMEOUT_MS: {
		kind: 'integer',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		default: 2_000,
		min: 1,
		max: 60_000,
		unit: 'milliseconds',
		ceiling:
			'A model server that has not answered the first probe in a minute is not coming, and the page waits for this probe.',
		summary: 'How long to wait for the model server to answer at all, before giving up.',
		page: 'ai-insights.md'
	},
	LLM_ALLOWED_HOSTS: {
		kind: 'text',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		format: 'comma-separated host names; a value replaces the default',
		default: 'localhost,127.0.0.1,[::1]',
		summary: 'The only hosts the model may be reached on.',
		page: 'ai-insights.md'
	},
	LLM_HTTP_PERMITTED_HOSTS: {
		kind: 'text',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		format: 'comma-separated host names, added to the local ones',
		summary: 'Hosts the model may be reached on over plain http rather than https.',
		page: 'ai-insights.md'
	},
	BP_LLM_QUEUE_DEPTH: {
		kind: 'integer',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		default: 2,
		min: 1,
		max: 8,
		unit: 'requests',
		ceiling:
			'One analysis runs at a time, so eight waiting is already minutes of queue: anyone further back is better told now that the model is busy.',
		summary: 'How many analyses may wait while one is running, before the next is refused as busy.',
		page: 'ai-insights.md'
	},
	BP_LLM_USER_HOURLY: {
		kind: 'integer',
		tier: 'advanced',
		group: 'AI insights',
		readBy: 'app',
		default: 20,
		min: 1,
		max: 120,
		unit: 'analyses per hour',
		ceiling:
			'120 is one analysis every thirty seconds for an hour, already more than a person reading the card asks for.',
		summary:
			'How many analyses one account may start in an hour. Advice served again from memory is not counted.',
		page: 'ai-insights.md'
	},

	// ── Logging ─────────────────────────────────────────────────────────────────────────────────
	BP_LOG_LEVEL: {
		kind: 'choice',
		tier: 'common',
		group: 'Logging',
		readBy: 'app',
		values: LOG_LEVELS,
		default: DEFAULT_LOG_LEVEL,
		otherwise: 'refused',
		summary:
			'How much the app writes to its log. No level silences the startup line or a security warning.',
		page: 'logging.md'
	},
	BP_SECURITY_LOG: {
		kind: 'choice',
		tier: 'common',
		group: 'Logging',
		readBy: 'app',
		values: SECURITY_LOG_VALUES,
		default: DEFAULT_SECURITY_LOG,
		otherwise: 'refused',
		summary:
			'Whether security events are written. Off is announced at every start, and cannot be hidden.',
		page: 'logging.md'
	},

	// ── Server process ──────────────────────────────────────────────────────────────────────────
	NODE_ENV: {
		kind: 'text',
		tier: 'advanced',
		group: 'Server process',
		readBy: 'app',
		format: 'production; any other value is a development run',
		default: 'production in the image',
		summary: 'Production unless you run a development checkout. The image sets it for you.',
		page: 'configuration.md'
	},
	PORT: {
		kind: 'text',
		tier: 'advanced',
		group: 'Server process',
		readBy: 'app',
		format: 'a TCP port number',
		default: '3000',
		summary: 'The port the server listens on inside the container. Change APP_PORT instead.',
		page: 'configuration.md'
	},
	HOST: {
		kind: 'text',
		tier: 'advanced',
		group: 'Server process',
		readBy: 'adapter-node',
		format: 'an address to listen on',
		default: '0.0.0.0',
		summary: 'The address the server listens on inside the container.',
		page: 'configuration.md'
	}
} as const satisfies Record<string, Setting>;

export type SettingName = keyof typeof SETTINGS;
export type IntegerSettingName = {
	[K in SettingName]: (typeof SETTINGS)[K] extends { kind: 'integer' } ? K : never;
}[SettingName];

/** The names that existed before R13 ruled that new ones start with `BP_`. Frozen: never added to. */
export const NAMES_BEFORE_THE_BP_PREFIX: readonly string[] = [
	'ORIGIN',
	'PUBLIC_INSTANCE',
	'REGISTRATION_MODE',
	'APP_PORT',
	'TOTP_ENCRYPTION_KEY',
	'RATE_LIMIT_HASH_SECRET',
	'BOOTSTRAP_TOKEN',
	'PASSWORD_HASH_COST',
	'SESSION_TTL_DAYS',
	'INVITATION_TTL_HOURS',
	'DATABASE_PROVIDER',
	'DATABASE_URL',
	'DATABASE_PASSWORD',
	'TRUSTED_PROXIES',
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'BODY_SIZE_LIMIT',
	'IMPORT_XLSX_MAX_UNCOMPRESSED_MB',
	'BACKUP_MAX_JSON_NODES',
	'CSV_MAX_COLUMNS',
	'COLUMN_MAPPINGS_PER_USER',
	'IMPORT_RATE_LIMIT_MAX_ATTEMPTS',
	'BANK_SYNC_ENABLED',
	'BANK_SYNC_ALLOWED_HOSTS',
	'BANK_SYNC_REDIRECT_ALLOWED_ORIGINS',
	'BANK_SYNC_FIRST_LOOKBACK_DAYS',
	'ENABLE_BANKING_APP_ID',
	'ENABLE_BANKING_PRIVATE_KEY',
	'ENABLE_BANKING_PRIVATE_KEY_PATH',
	'ENABLE_BANKING_BASE_URL',
	'LLM_ENABLED',
	'LLM_PROVIDER',
	'LLM_BASE_URL',
	'LLM_MODEL',
	'LLM_TIMEOUT_MS',
	'LLM_CONNECT_TIMEOUT_MS',
	'LLM_ALLOWED_HOSTS',
	'LLM_HTTP_PERMITTED_HOSTS',
	'NODE_ENV',
	'PORT',
	'HOST'
];
