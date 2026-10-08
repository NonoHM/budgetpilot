/**
 * Every name a log line can carry, in one place (#250, comment of 2026-10-01).
 *
 * Three vocabularies, each from the source that owns it, so an upstream rename is a change to this
 * file and nothing else:
 *
 *  - FIELD: the OpenTelemetry Logs Data Model, whose specification reads « Status: Stable », written
 *    as flat snake_case keys (`timestamp`, `severity_number`, `event_name`, `trace_id`, `body`).
 *    https://opentelemetry.io/docs/specs/otel/logs/data-model/
 *  - ATTRIBUTE: the OpenTelemetry semantic conventions marked Stable (`service.name`,
 *    `http.request.method`, `http.route`, `http.response.status_code`, `error.type`), and
 *    `budgetpilot.*` for everything this application defines itself.
 *  - EVENT: the OWASP Logging Vocabulary where it has a name (`sys_startup`, `sys_crash`,
 *    `sys_monitor_disabled`), without the user the vocabulary appends, because an identifier inside a
 *    name that must stay static and low-cardinality is a join key nobody chose. Everything else is
 *    `budgetpilot.<area>.<what>`.
 *
 * A renamed field is a new field: the old name stays readable until it is deprecated, because a
 * collector recipe matches on the name it was written for. `SCHEMA_VERSION` changes when a name
 * here changes meaning.
 *
 * Imported by `boot.mjs` as TypeScript source, so this file uses only erasable syntax and imports
 * nothing.
 */

/** Bumped when any name below changes meaning or is removed. Adding a name does not bump it. */
export const SCHEMA_VERSION = 1;

export const FIELD = {
	timestamp: 'timestamp',
	severityText: 'severity_text',
	severityNumber: 'severity_number',
	eventName: 'event_name',
	body: 'body',
	traceId: 'trace_id'
} as const;

export const ATTRIBUTE = {
	// OpenTelemetry, Stable.
	serviceName: 'service.name',
	serviceVersion: 'service.version',
	httpMethod: 'http.request.method',
	httpRoute: 'http.route',
	httpStatus: 'http.response.status_code',
	errorType: 'error.type',

	// The envelope's own integrity fields.
	logSchema: 'budgetpilot.log.schema',
	logBootId: 'budgetpilot.log.boot_id',
	logSeq: 'budgetpilot.log.seq',
	logPrev: 'budgetpilot.log.prev',

	// Errors, mapped from `loggableError` (server/errors.ts) and nothing else.
	errorCode: 'budgetpilot.error.code',
	errorId: 'budgetpilot.error.id',
	errorOperatorMessage: 'budgetpilot.error.operator_message',
	causeType: 'budgetpilot.error.cause_type',
	causeCode: 'budgetpilot.error.cause_code',
	crashOrigin: 'budgetpilot.crash.origin',

	// Configuration read at boot.
	configPublicInstance: 'budgetpilot.config.public_instance',
	configCookiesSecure: 'budgetpilot.config.cookies_secure',
	configDatabaseProvider: 'budgetpilot.config.database_provider',
	configTrustedProxyRanges: 'budgetpilot.config.trusted_proxy_ranges',
	configOriginSet: 'budgetpilot.config.origin_set',
	configOrigin: 'budgetpilot.config.origin',
	configSecurityLog: 'budgetpilot.config.security_log',
	configLogLevel: 'budgetpilot.config.log_level',
	configName: 'budgetpilot.config.name',
	configValue: 'budgetpilot.config.value',
	configDefault: 'budgetpilot.config.default',
	configDirection: 'budgetpilot.config.direction',
	configBelowHonestMinimum: 'budgetpilot.config.below_honest_minimum',
	configFileMode: 'budgetpilot.config.file_mode',
	monitor: 'budgetpilot.monitor',

	// Boot backfills.
	backfillName: 'budgetpilot.backfill.name',
	backfillStage: 'budgetpilot.backfill.stage',
	backfillCount: 'budgetpilot.backfill.count',
	backfillPending: 'budgetpilot.backfill.pending',
	backfillUnkeyed: 'budgetpilot.backfill.unkeyed',
	backfillBatchesFiled: 'budgetpilot.backfill.batches_filed',
	backfillUsers: 'budgetpilot.backfill.users',
	backfillRowsMerged: 'budgetpilot.backfill.rows_merged',
	backfillRepointed: 'budgetpilot.backfill.transactions_repointed',
	backfillWaitedSeconds: 'budgetpilot.backfill.waited_seconds',
	backfillAccountGroups: 'budgetpilot.backfill.account_groups',
	backfillNetWorthGroups: 'budgetpilot.backfill.net_worth_groups',
	netWorthLinesContested: 'budgetpilot.net_worth.lines_contested',
	netWorthLinksWithdrawn: 'budgetpilot.net_worth.links_withdrawn',
	datesTotal: 'budgetpilot.dates.total',
	datesCounts: 'budgetpilot.dates.counts',
	datesFirstStorableYear: 'budgetpilot.dates.first_storable_year',
	databaseOwnsDatabase: 'budgetpilot.database.owns_database',
	databaseBootstrapRole: 'budgetpilot.database.bootstrap_role',

	// Request-time subsystems.
	bankConnectionId: 'budgetpilot.bank.connection_id',
	bankProviderCode: 'budgetpilot.bank.provider_code',
	rulesReason: 'budgetpilot.rules.reason',
	rulesSource: 'budgetpilot.rules.source',
	rulesKey: 'budgetpilot.rules.key',
	importStage: 'budgetpilot.import.stage',
	importLandedRows: 'budgetpilot.import.landed_rows',
	countsKind: 'budgetpilot.transactions.counts_kind',

	// Authentication events (L3). The client and the user only as keyed hashes (`pseudonym.ts`):
	// never OpenTelemetry's `client.address` or `user.id`, which name the raw values.
	userPseudonym: 'budgetpilot.user.pseudonym',
	clientPseudonym: 'budgetpilot.client.pseudonym',
	clientSubnetPseudonym: 'budgetpilot.client.subnet_pseudonym',
	clientSubnetPrefixLength: 'budgetpilot.client.subnet_prefix_length',
	authnStep: 'budgetpilot.authn.step',
	authnReason: 'budgetpilot.authn.reason',
	authnFactor: 'budgetpilot.authn.factor',
	authnMethod: 'budgetpilot.authn.method',
	authnAction: 'budgetpilot.authn.action',
	rateLimitKind: 'budgetpilot.ratelimit.kind',
	rateLimitCounter: 'budgetpilot.ratelimit.counter',
	sessionReason: 'budgetpilot.session.reason',

	// The container start, `boot.mjs`.
	bootDirectory: 'budgetpilot.boot.directory',
	bootUid: 'budgetpilot.boot.uid',
	bootExitCode: 'budgetpilot.boot.exit_code',

	// The logger about itself.
	suppressedEvent: 'budgetpilot.log.suppressed_event',
	suppressedCount: 'budgetpilot.log.suppressed_count',
	suppressedWindowSeconds: 'budgetpilot.log.window_seconds',
	suppressedRoute: 'budgetpilot.log.suppressed_route',
	suppressedErrorType: 'budgetpilot.log.suppressed_error_type',
	suppressedStatus: 'budgetpilot.log.suppressed_status',
	droppedBytes: 'budgetpilot.log.dropped_bytes',
	consoleMethod: 'budgetpilot.console.method',
	consoleText: 'budgetpilot.console.text'
} as const;

export const EVENT = {
	// OWASP Logging Vocabulary.
	sysStartup: 'sys_startup',
	sysCrash: 'sys_crash',
	sysMonitorDisabled: 'sys_monitor_disabled',

	// OWASP Logging Vocabulary, authentication. The vocabulary has no name for a second factor, a
	// re-authentication, a failed registration or a dead session cookie, so those are ours.
	authnLoginSuccess: 'authn_login_success',
	authnLoginFail: 'authn_login_fail',
	rateLimitExceeded: 'excess_rate_limit_exceeded',
	userCreated: 'user_created',
	authnLogout: 'session_logout',
	authnSecondFactorRequired: 'budgetpilot.authn.second_factor_required',
	authnRegisterFail: 'budgetpilot.authn.register_fail',
	authnReauthSuccess: 'budgetpilot.authn.reauth_success',
	authnReauthFail: 'budgetpilot.authn.reauth_fail',
	sessionInvalid: 'budgetpilot.session.invalid',

	configOriginSet: 'budgetpilot.config.origin_set',
	configOriginUnset: 'budgetpilot.config.origin_unset',
	configTrustedProxiesUnset: 'budgetpilot.config.trusted_proxies_unset',
	configInsecureCookies: 'budgetpilot.config.insecure_cookies',
	configBootstrapTokenEmpty: 'budgetpilot.config.bootstrap_token_empty',
	configBoundChanged: 'budgetpilot.config.bound_changed',
	configLogLevelChanged: 'budgetpilot.config.log_level_changed',
	configEnvFileExposed: 'budgetpilot.config.env_file_exposed',

	requestFailed: 'budgetpilot.request.failed',
	requestNotFound: 'budgetpilot.request.not_found',

	backfillStarted: 'budgetpilot.backfill.started',
	backfillProgress: 'budgetpilot.backfill.progress',
	backfillCompleted: 'budgetpilot.backfill.completed',
	backfillLockWait: 'budgetpilot.backfill.lock_wait',
	backfillMergesBlocked: 'budgetpilot.backfill.merges_blocked',
	netWorthLinksWithdrawn: 'budgetpilot.net_worth.links_withdrawn',
	datesCheckFailed: 'budgetpilot.dates.check_failed',
	datesOutsideStorableRange: 'budgetpilot.dates.outside_storable_range',
	databaseOverprivileged: 'budgetpilot.database.overprivileged',

	bankBalanceFetchFailed: 'budgetpilot.bank.balance_fetch_failed',
	rulesCatalogEntrySkipped: 'budgetpilot.rules.catalog_entry_skipped',
	importWriteFailed: 'budgetpilot.import.write_failed',
	importAccountNotRemembered: 'budgetpilot.import.account_not_remembered',
	transactionsCountsUnavailable: 'budgetpilot.transactions.counts_unavailable',

	bootLegacyDatabaseAdopted: 'budgetpilot.boot.legacy_database_adopted',
	bootDataDirReadOnly: 'budgetpilot.boot.data_dir_read_only',
	bootDataDirNotWritable: 'budgetpilot.boot.data_dir_not_writable',
	bootDataDirUnusable: 'budgetpilot.boot.data_dir_unusable',
	bootMigrateFailed: 'budgetpilot.boot.migrate_failed',

	logSuppressed: 'budgetpilot.log.suppressed',
	logLineTooLong: 'budgetpilot.log.line_too_long',
	consoleOutput: 'budgetpilot.console.output'
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];
export type AttributeName = (typeof ATTRIBUTE)[keyof typeof ATTRIBUTE];

/** `service.name` on every line, so a collector receiving several applications can tell them apart. */
export const SERVICE_NAME = 'budgetpilot';
