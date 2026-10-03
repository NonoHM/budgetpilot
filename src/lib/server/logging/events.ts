import { ATTRIBUTE as A, EVENT as E, type EventName } from './names.ts';

/**
 * Every event this application can write, as a type: the only way to put a line in the log is to
 * build one of these, so a field that is not declared here cannot be written (#250).
 *
 * WHAT A FIELD MAY BE. A closed set, a number, a boolean, a server-generated identifier, a value
 * checked against a pattern (an error class or code), or text this application or its operator
 * wrote (the configured `ORIGIN`, an `OperatorFacingError` message, a shipped rule file's name).
 * No field carries text a visitor or a remote host chose, with one exception named in the
 * registry below: `budgetpilot.console.text`, which is what third-party code printed, capped and
 * escaped, because our own code is forbidden `console` by the lint rule.
 *
 * WHAT A FIELD IS, by the classification in `docs/explanation/data-classification.md`. Every
 * attribute has its level in REGISTRY, and the type of REGISTRY makes an attribute without one a
 * compile error. Only Operational and Pseudonymous may appear in a log at all; Secret, Financial
 * and Personal may not, so they are not members of `LogLevel` and cannot be declared.
 *
 * Imported by `boot.mjs` as TypeScript source: erasable syntax only, relative imports only.
 */

/** The classification levels a log field may hold. The other three may never be logged. */
export type LogLevel = 'Operational' | 'Pseudonymous';

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** What `loggableError` (server/errors.ts) returns, under the names the log writes it as. */
export interface ErrorFields {
	[A.errorType]: string;
	[A.errorCode]?: string;
	[A.errorOperatorMessage]?: string;
}

export type BackfillName =
	'name_keys' | 'dedupe_key_hashes' | 'dedupe_key_recompute' | 'statement_accounts';

export type BoundName =
	| 'IMPORT_RATE_LIMIT_MAX_ATTEMPTS'
	| 'BACKUP_MAX_JSON_NODES'
	| 'CSV_MAX_COLUMNS'
	| 'COLUMN_MAPPINGS_PER_USER'
	| 'IMPORT_XLSX_MAX_UNCOMPRESSED_MB';

export type LogEvent =
	| {
			event: typeof E.sysStartup;
			attributes: {
				[A.serviceVersion]: string;
				[A.configPublicInstance]: 'secure' | 'lan';
				[A.configCookiesSecure]: boolean;
				[A.configDatabaseProvider]: 'sqlite' | 'postgresql' | 'mysql';
				[A.configTrustedProxyRanges]: number;
				[A.configOriginSet]: boolean;
				[A.configSecurityLog]: 'on' | 'off' | 'refused';
				[A.configLogLevel]: 'debug' | 'info' | 'warn' | 'refused';
			};
	  }
	| {
			event: typeof E.sysCrash;
			attributes: ErrorFields & {
				[A.crashOrigin]: 'uncaughtException' | 'unhandledRejection';
			};
	  }
	| { event: typeof E.sysMonitorDisabled; attributes: { [A.monitor]: 'security_log' } }
	| { event: typeof E.configOriginSet; attributes: { [A.configOrigin]: string } }
	| { event: typeof E.configOriginUnset; attributes: Record<never, never> }
	| { event: typeof E.configTrustedProxiesUnset; attributes: Record<never, never> }
	| { event: typeof E.configInsecureCookies; attributes: Record<never, never> }
	| { event: typeof E.configBootstrapTokenEmpty; attributes: Record<never, never> }
	| {
			event: typeof E.configBoundChanged;
			attributes: {
				[A.configName]: BoundName;
				[A.configValue]: number;
				[A.configDefault]: number;
				[A.configDirection]: 'raised' | 'lowered';
				[A.configBelowHonestMinimum]: boolean;
			};
	  }
	| { event: typeof E.configLogLevelChanged; attributes: { [A.configLogLevel]: string } }
	| {
			event: typeof E.requestFailed;
			attributes: ErrorFields & {
				[A.httpStatus]: number;
				[A.errorId]: string;
			};
	  }
	| {
			event: typeof E.requestNotFound;
			attributes: { [A.httpStatus]: number; [A.errorId]: string };
	  }
	| { event: typeof E.backfillStarted; attributes: { [A.backfillName]: BackfillName } }
	| {
			event: typeof E.backfillProgress;
			attributes: {
				[A.backfillName]: BackfillName;
				[A.backfillStage]: 'keys' | 'accounts_named' | 'batches_filed';
				[A.backfillCount]: number;
				[A.backfillPending]?: number;
			};
	  }
	| {
			event: typeof E.backfillCompleted;
			attributes: {
				[A.backfillName]: BackfillName;
				[A.backfillCount]: number;
				[A.backfillUnkeyed]?: number;
				[A.backfillBatchesFiled]?: number;
				[A.backfillUsers]?: number;
				[A.backfillRowsMerged]?: number;
				[A.backfillRepointed]?: number;
			};
	  }
	| {
			event: typeof E.backfillLockWait;
			attributes: { [A.backfillName]: string; [A.backfillWaitedSeconds]: number };
	  }
	| {
			event: typeof E.backfillMergesBlocked;
			attributes: { [A.backfillAccountGroups]: number; [A.backfillNetWorthGroups]: number };
	  }
	| {
			event: typeof E.netWorthLinksWithdrawn;
			attributes: { [A.netWorthLinesContested]: number; [A.netWorthLinksWithdrawn]: number };
	  }
	| { event: typeof E.datesCheckFailed; attributes: Record<never, never> }
	| {
			event: typeof E.datesOutsideStorableRange;
			attributes: {
				[A.datesTotal]: number;
				[A.datesCounts]: string;
				[A.datesFirstStorableYear]: number;
			};
	  }
	| {
			event: typeof E.databaseOverprivileged;
			attributes: { [A.databaseOwnsDatabase]: boolean; [A.databaseBootstrapRole]: boolean };
	  }
	| {
			event: typeof E.bankBalanceFetchFailed;
			attributes: {
				[A.bankConnectionId]: string;
				[A.errorType]: 'http_error' | 'sync_failed';
				[A.httpStatus]?: number;
				[A.bankProviderCode]?: string;
			};
	  }
	| {
			event: typeof E.rulesCatalogEntrySkipped;
			attributes: {
				[A.rulesReason]: 'invalid_schema' | 'duplicate_key' | 'dangerous_regex';
				[A.rulesSource]: string;
				[A.rulesKey]?: string;
			};
	  }
	| {
			event: typeof E.importWriteFailed;
			attributes: ErrorFields & {
				[A.importStage]: 'batch' | 'rows' | 'cleanup';
				[A.importLandedRows]?: number;
				[A.causeType]?: string;
				[A.causeCode]?: string;
			};
	  }
	| { event: typeof E.importAccountNotRemembered; attributes: Record<never, never> }
	| {
			event: typeof E.transactionsCountsUnavailable;
			attributes: { [A.countsKind]: 'tags' | 'splits'; [A.errorType]: string };
	  }
	| { event: typeof E.bootLegacyDatabaseAdopted; attributes: Record<never, never> }
	| {
			event: typeof E.bootDataDirReadOnly;
			attributes: { [A.bootDirectory]: string };
	  }
	| {
			event: typeof E.bootDataDirNotWritable;
			attributes: { [A.bootDirectory]: string; [A.bootUid]: number };
	  }
	| {
			event: typeof E.bootDataDirUnusable;
			attributes: { [A.bootDirectory]: string; [A.bootUid]: number; [A.errorCode]?: string };
	  }
	| { event: typeof E.bootMigrateFailed; attributes: { [A.bootExitCode]: number } }
	| {
			event: typeof E.logSuppressed;
			attributes: {
				[A.suppressedEvent]: EventName;
				[A.suppressedCount]: number;
				[A.suppressedWindowSeconds]: number;
				[A.suppressedStatus]?: number;
				[A.suppressedRoute]?: string;
				[A.suppressedErrorType]?: string;
			};
	  }
	| {
			event: typeof E.logLineTooLong;
			attributes: { [A.suppressedEvent]: string; [A.droppedBytes]: number };
	  }
	| {
			event: typeof E.consoleOutput;
			attributes: {
				[A.consoleMethod]: 'log' | 'info' | 'debug' | 'warn' | 'error' | 'trace';
				[A.consoleText]: string;
			};
	  };

export type AttributesOf<N extends EventName> = Extract<LogEvent, { event: N }>['attributes'];

export interface EventSpec<Attributes> {
	severity: Severity;
	/** One fixed English sentence: what happened and, where an operator can act, what to do. */
	body: string;
	/** Reachable without a session at request time, so repeats inside a window are summarised. */
	flood: boolean;
	/** A security event in the sense of BP_SECURITY_LOG: dropped when the operator turns it off. */
	security: boolean;
	attributes: { [K in keyof Required<Attributes>]: LogLevel };
}

const ERROR_LEVELS = {
	[A.errorType]: 'Operational',
	[A.errorCode]: 'Operational',
	[A.errorOperatorMessage]: 'Operational'
} as const;

/**
 * The inventory as data: `docs/logging.md` lists every row of it by hand, and
 * `logInventory.spec.ts` fails when the page and this object disagree.
 */
export const REGISTRY: { [N in EventName]: EventSpec<AttributesOf<N>> } = {
	[E.sysStartup]: {
		severity: 'WARN',
		body: 'BudgetPilot started. The attributes are the security-relevant configuration it started with.',
		flood: false,
		security: false,
		attributes: {
			[A.serviceVersion]: 'Operational',
			[A.configPublicInstance]: 'Operational',
			[A.configCookiesSecure]: 'Operational',
			[A.configDatabaseProvider]: 'Operational',
			[A.configTrustedProxyRanges]: 'Operational',
			[A.configOriginSet]: 'Operational',
			[A.configSecurityLog]: 'Operational',
			[A.configLogLevel]: 'Operational'
		}
	},
	[E.sysCrash]: {
		severity: 'FATAL',
		body: 'BudgetPilot stopped on an error nothing caught. It exits with status 1.',
		flood: false,
		security: false,
		attributes: { ...ERROR_LEVELS, [A.crashOrigin]: 'Operational' }
	},
	[E.sysMonitorDisabled]: {
		severity: 'WARN',
		body: 'Security event logging is off (BP_SECURITY_LOG=off): authentication, authorization and control-bypass events are not written.',
		flood: false,
		security: false,
		attributes: { [A.monitor]: 'Operational' }
	},
	[E.configOriginSet]: {
		severity: 'WARN',
		body: 'Form submissions are accepted only from this exact origin. If it is not the URL you type in the browser, protocol and port included, every sign-in is refused as cross-site.',
		flood: false,
		security: false,
		attributes: { [A.configOrigin]: 'Operational' }
	},
	[E.configOriginUnset]: {
		severity: 'WARN',
		body: 'ORIGIN is unset, so on a plain-http deployment every form submission fails as cross-site while pages still load. Set ORIGIN to the exact URL you type in the browser (docs/troubleshooting.md).',
		flood: false,
		security: false,
		attributes: {}
	},
	[E.configTrustedProxiesUnset]: {
		severity: 'WARN',
		body: 'TRUSTED_PROXIES is unset, so X-Forwarded-For is not trusted and rate limiting keys on the socket peer. Behind a reverse proxy, set it, or every visitor shares the proxy address (docs/reverse-proxy.md).',
		flood: false,
		security: false,
		attributes: {}
	},
	[E.configInsecureCookies]: {
		severity: 'WARN',
		body: 'PUBLIC_INSTANCE=false: session cookies are sent without the Secure flag. Correct for a private instance on a trusted network over http, unsafe anywhere else.',
		flood: false,
		security: false,
		attributes: {}
	},
	[E.configBootstrapTokenEmpty]: {
		severity: 'WARN',
		body: 'BOOTSTRAP_TOKEN is empty while REGISTRATION_MODE=admin_only: no account can be created except through an invitation link from the admin panel.',
		flood: false,
		security: false,
		attributes: {}
	},
	[E.configBoundChanged]: {
		severity: 'WARN',
		body: 'An operator bound differs from its default. docs/configuration.md says what the bound protects and what each direction costs.',
		flood: false,
		security: false,
		attributes: {
			[A.configName]: 'Operational',
			[A.configValue]: 'Operational',
			[A.configDefault]: 'Operational',
			[A.configDirection]: 'Operational',
			[A.configBelowHonestMinimum]: 'Operational'
		}
	},
	[E.configLogLevelChanged]: {
		severity: 'WARN',
		body: 'BP_LOG_LEVEL differs from its default of info.',
		flood: false,
		security: false,
		attributes: { [A.configLogLevel]: 'Operational' }
	},
	[E.requestFailed]: {
		severity: 'ERROR',
		body: 'A request failed on an unexpected error. The error id is the reference the visitor was shown.',
		flood: true,
		security: false,
		attributes: { ...ERROR_LEVELS, [A.httpStatus]: 'Operational', [A.errorId]: 'Operational' }
	},
	[E.requestNotFound]: {
		severity: 'INFO',
		body: 'A request matched no page.',
		flood: true,
		security: false,
		attributes: { [A.httpStatus]: 'Operational', [A.errorId]: 'Operational' }
	},
	[E.backfillStarted]: {
		severity: 'INFO',
		body: 'A one-time boot backfill started.',
		flood: false,
		security: false,
		attributes: { [A.backfillName]: 'Operational' }
	},
	[E.backfillProgress]: {
		severity: 'INFO',
		body: 'A one-time boot backfill is progressing.',
		flood: false,
		security: false,
		attributes: {
			[A.backfillName]: 'Operational',
			[A.backfillStage]: 'Operational',
			[A.backfillCount]: 'Operational',
			[A.backfillPending]: 'Operational'
		}
	},
	[E.backfillCompleted]: {
		severity: 'INFO',
		body: 'A one-time boot backfill completed.',
		flood: false,
		security: false,
		attributes: {
			[A.backfillName]: 'Operational',
			[A.backfillCount]: 'Operational',
			[A.backfillUnkeyed]: 'Operational',
			[A.backfillBatchesFiled]: 'Operational',
			[A.backfillUsers]: 'Operational',
			[A.backfillRowsMerged]: 'Operational',
			[A.backfillRepointed]: 'Operational'
		}
	},
	[E.backfillLockWait]: {
		severity: 'INFO',
		body: 'Waiting for another instance to finish a one-time backfill.',
		flood: false,
		security: false,
		attributes: { [A.backfillName]: 'Operational', [A.backfillWaitedSeconds]: 'Operational' }
	},
	[E.backfillMergesBlocked]: {
		severity: 'WARN',
		body: 'Some names now read as duplicates and were left untouched. Run scripts/normalize-names.mjs --dry-run to see which.',
		flood: false,
		security: false,
		attributes: {
			[A.backfillAccountGroups]: 'Operational',
			[A.backfillNetWorthGroups]: 'Operational'
		}
	},
	[E.netWorthLinksWithdrawn]: {
		severity: 'WARN',
		body: 'Net worth accounts fed by more than one synchronized bank account had their links withdrawn (#501). Set the one that should feed each line again in Settings.',
		flood: false,
		security: false,
		attributes: {
			[A.netWorthLinesContested]: 'Operational',
			[A.netWorthLinksWithdrawn]: 'Operational'
		}
	},
	[E.datesCheckFailed]: {
		severity: 'WARN',
		body: 'The check for rows dated before the storable range could not run; nothing was changed.',
		flood: false,
		security: false,
		attributes: {}
	},
	[E.datesOutsideStorableRange]: {
		severity: 'WARN',
		body: 'Rows carry a date before the storable range (#758). They can display in the wrong century and a backup holding them is refused on restore. Nothing was changed.',
		flood: false,
		security: false,
		attributes: {
			[A.datesTotal]: 'Operational',
			[A.datesCounts]: 'Operational',
			[A.datesFirstStorableYear]: 'Operational'
		}
	},
	[E.databaseOverprivileged]: {
		severity: 'WARN',
		body: 'The app connects to PostgreSQL with more privilege than it uses, including rights that run programs on the database host. docs/database-providers.md, "The app\'s database account", says how to reduce it.',
		flood: false,
		security: false,
		attributes: {
			[A.databaseOwnsDatabase]: 'Operational',
			[A.databaseBootstrapRole]: 'Operational'
		}
	},
	[E.bankBalanceFetchFailed]: {
		severity: 'WARN',
		body: 'A bank balance fetch failed; the transactions of the same sync are kept.',
		flood: false,
		security: false,
		attributes: {
			[A.bankConnectionId]: 'Operational',
			[A.errorType]: 'Operational',
			[A.httpStatus]: 'Operational',
			[A.bankProviderCode]: 'Operational'
		}
	},
	[E.rulesCatalogEntrySkipped]: {
		severity: 'WARN',
		body: 'A shipped default rule was skipped while loading the catalogue.',
		flood: false,
		security: false,
		attributes: {
			[A.rulesReason]: 'Operational',
			[A.rulesSource]: 'Operational',
			[A.rulesKey]: 'Operational'
		}
	},
	[E.importWriteFailed]: {
		severity: 'ERROR',
		body: 'An import write step failed.',
		flood: false,
		security: false,
		attributes: {
			...ERROR_LEVELS,
			[A.importStage]: 'Operational',
			[A.importLandedRows]: 'Operational',
			[A.causeType]: 'Operational',
			[A.causeCode]: 'Operational'
		}
	},
	[E.importAccountNotRemembered]: {
		severity: 'WARN',
		body: 'An answered import account could not be remembered; the import itself went through.',
		flood: true,
		security: false,
		attributes: {}
	},
	[E.transactionsCountsUnavailable]: {
		severity: 'WARN',
		body: 'Filter counts on the transactions page could not be computed; the page renders without them.',
		flood: true,
		security: false,
		attributes: { [A.countsKind]: 'Operational', [A.errorType]: 'Operational' }
	},
	[E.bootLegacyDatabaseAdopted]: {
		severity: 'WARN',
		body: "Using /data/dev.db, where this install's database already is. Nothing was moved. To adopt /data/budgetpilot.db, stop the container and rename the file and its -wal and -shm siblings; to keep the old name, set DATABASE_URL=file:/data/dev.db.",
		flood: false,
		security: false,
		attributes: {}
	},
	[E.bootDataDirReadOnly]: {
		severity: 'FATAL',
		body: 'The SQLite directory is on a read-only filesystem. The container runs with a read-only root by design and the directory must be a mounted volume: in Compose the budgetpilot_data:/data volume, with docker run -v budgetpilot_data:/data. DATABASE_URL must point inside /data.',
		flood: false,
		security: false,
		attributes: { [A.bootDirectory]: 'Operational' }
	},
	[E.bootDataDirNotWritable]: {
		severity: 'FATAL',
		body: 'The SQLite directory is not writable by this uid. After an upgrade from an image older than the distroless one, the volume is still owned by the old uid: with the container stopped, find the volume with docker volume ls, then docker run --rm -v <that name>:/data busybox chown -R 65532:65532 /data.',
		flood: false,
		security: false,
		attributes: { [A.bootDirectory]: 'Operational', [A.bootUid]: 'Operational' }
	},
	[E.bootDataDirUnusable]: {
		severity: 'FATAL',
		body: 'The SQLite directory could not be written, so the app cannot start.',
		flood: false,
		security: false,
		attributes: {
			[A.bootDirectory]: 'Operational',
			[A.bootUid]: 'Operational',
			[A.errorCode]: 'Operational'
		}
	},
	[E.bootMigrateFailed]: {
		severity: 'FATAL',
		body: 'prisma migrate deploy failed, so the app refuses to start. Its own output is above this line.',
		flood: false,
		security: false,
		attributes: { [A.bootExitCode]: 'Operational' }
	},
	[E.logSuppressed]: {
		severity: 'WARN',
		body: 'Repeats of one event were summarised instead of written, so the log cannot be used to fill the disk.',
		flood: false,
		security: false,
		attributes: {
			[A.suppressedEvent]: 'Operational',
			[A.suppressedCount]: 'Operational',
			[A.suppressedWindowSeconds]: 'Operational',
			[A.suppressedStatus]: 'Operational',
			[A.suppressedRoute]: 'Operational',
			[A.suppressedErrorType]: 'Operational'
		}
	},
	[E.logLineTooLong]: {
		severity: 'WARN',
		body: 'A line exceeded the size a collector accepts, so its attributes were dropped.',
		flood: false,
		security: false,
		attributes: { [A.suppressedEvent]: 'Operational', [A.droppedBytes]: 'Operational' }
	},
	[E.consoleOutput]: {
		severity: 'WARN',
		body: 'A dependency wrote to the console. The text is what it printed, capped and escaped.',
		flood: true,
		security: false,
		attributes: { [A.consoleMethod]: 'Operational', [A.consoleText]: 'Operational' }
	}
};
