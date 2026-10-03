# Logs

**Audience:** whoever runs the instance, and contributors who add a log line. **Type:**
reference.

Every line BudgetPilot itself writes is one JSON object on standard output: no file, no network
destination. Two streams share the same output and are not JSON: what `prisma migrate deploy`
prints on every start, and what Node prints for an error thrown before the server's handlers
exist (the table below). This page lists what is logged, in which format, where it
goes, who can read it, how long it is kept, and every event with each field's protection level from
[the data classification](./explanation/data-classification.md).

## Where the log goes, and who can read it

| Layer                                                                                                      | What it writes                                                                                                          | Where it goes                                                       |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The server (`src/hooks.server.ts` and every module under `src/lib/server`)                                 | The events listed at the end of this page, through one writer (`src/lib/server/logging`)                                | Standard output of the process                                      |
| The container start (`boot.mjs`)                                                                           | The `budgetpilot.boot.*` events, through the same writer's core                                                         | Standard output, before the server starts                           |
| `prisma migrate deploy`, which `boot.mjs` runs on every start                                              | Its own plain-text output, not filtered by the application ([#846](https://github.com/NonoHM/budgetpilot/issues/846))   | Standard output, between the boot lines and the server's first line |
| A dependency that prints through the console (adapter-node's « Listening on »)                             | Wrapped as `budgetpilot.console.output`, capped and escaped: `log`, `info`, `debug`, `warn`, `error`, `trace` and `dir` | Standard output                                                     |
| A dependency that writes to `process.stdout` or `process.stderr` itself                                    | Not wrapped: no wrapper of the console sees it, and none is known to do so today                                        | Standard output or standard error                                   |
| Node itself, for an error thrown while modules are still loading, before the server's error handlers exist | Node's own printer                                                                                                      | Standard error                                                      |

Under Docker the container runtime keeps standard output in its log driver. Anyone who can run
`docker logs` or read `/var/lib/docker/containers` on the host can read the log, which in practice
means root and members of the `docker` group. The application has no access control of its own over
it. Whoever ships the log to a collector decides who can read it there.

The application never sends the log anywhere. It has no transport, no OpenTelemetry SDK and no
vendor format.

## What a line looks like

A sign-in page that matched no route, as written (one line, wrapped here):

```json
{
	"severity_text": "INFO",
	"severity_number": 9,
	"timestamp": "2026-10-03T12:00:00.000Z",
	"event_name": "budgetpilot.request.not_found",
	"trace_id": "4f1c0e2a9b7d4c3e8a6f5d4c3b2a1908",
	"http.request.method": "GET",
	"service.name": "budgetpilot",
	"http.response.status_code": 404,
	"budgetpilot.error.id": "4f1c0e2a-9b7d-4c3e-8a6f-5d4c3b2a1908",
	"budgetpilot.log.schema": 1,
	"budgetpilot.log.boot_id": "6b1a99b8-01af-4b1d-b0d0-a3fb9b833f48",
	"budgetpilot.log.seq": 42,
	"budgetpilot.log.prev": "9c1f...e07a",
	"body": "A request matched no page."
}
```

The field names follow the [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/),
whose specification is marked Stable, and the semantic conventions marked Stable for the
`service.*`, `http.*` and `error.type` attributes. Everything BudgetPilot defines itself is under
`budgetpilot.*`. Event names come from the [OWASP Logging Vocabulary](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Vocabulary_Cheat_Sheet.html)
where it has one (`sys_startup`, `sys_crash`, `sys_monitor_disabled`), without the user name the
vocabulary appends to them. One file owns every name, `src/lib/server/logging/names.ts`.

### The envelope

Every line carries these fields, whatever the event.

| Field                              | Meaning                                                                                                                                | Level       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `timestamp`                        | When the line was written, ISO 8601 in UTC. As accurate as the host clock: keep it synchronised (NTP)                                  | Operational |
| `severity_text`, `severity_number` | `DEBUG` 5, `INFO` 9, `WARN` 13, `ERROR` 17, `FATAL` 21, on OpenTelemetry's 1 to 24 scale                                               | Operational |
| `event_name`                       | One of the events at the end of this page                                                                                              | Operational |
| `body`                             | One fixed English sentence per event, never assembled from data                                                                        | Operational |
| `service.name`                     | Always `budgetpilot`                                                                                                                   | Operational |
| `budgetpilot.log.schema`           | The version of these names, `1`. It changes when a name changes meaning or is removed                                                  | Operational |
| `budgetpilot.log.boot_id`          | A random identifier for this process, new at every start                                                                               | Operational |
| `budgetpilot.log.seq`              | 1 for the first line of the process, then one more per line                                                                            | Operational |
| `budgetpilot.log.prev`             | The SHA-256, in hexadecimal, of the previous line as written, without its trailing newline; 64 zeros on the first line of each process | Operational |

A line written while a request is handled also carries:

| Field                 | Meaning                                                                                                                                           | Level       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `trace_id`            | An identifier the server generates for the request, 32 hexadecimal characters. An `X-Request-Id` header sent by a client or a proxy is never read | Operational |
| `http.request.method` | The method, or `_OTHER` for one outside the standard list                                                                                         | Operational |
| `http.route`          | The matched route template, such as `/imports/[batchId]`. Absent when no route matched. The path itself is never logged                           | Operational |

When a request fails, the error page shows the visitor a reference. That reference is the line's
`budgetpilot.error.id`, and the same value without its dashes is the `trace_id`.

### What a field may contain

No field carries text a visitor or a remote host chose. Each is a closed set of values, a number, a
boolean, an identifier the server generated, a value checked against a pattern (an error class or
code), or text the application or its operator wrote: the configured `ORIGIN`, the message of a
refusal written for the operator, the name of a shipped rule file. The one exception is
`budgetpilot.console.text`, which is what a dependency printed.

On top of JSON's own escaping, the writer escapes U+2028, U+2029, DEL and every C0 and C1 control
character as `\uXXXX`, so no value can start a new line in a viewer or repaint a terminal. A string
value is cut at 256 characters, or 2048 for an operator message, and a line longer than 8192 bytes
is replaced by a `budgetpilot.log.line_too_long` line that keeps the envelope. Docker splits a line
longer than 16 KiB into two records.

Nothing classified Secret, Financial or Personal may appear in a log
([data classification, « In a log »](./explanation/data-classification.md#what-each-level-requires)).
`e2e/log-secret-scan.spec.ts` searches a built server's log for every secret a run handles and
mints, and `e2e/log-injection.spec.ts` plants line separators in every input a visitor reaches and
counts what reaches the log unescaped. Both run in CI.

## Checking that nothing was removed or edited

Each line names its predecessor's hash, so a gap in `budgetpilot.log.seq` or a
`budgetpilot.log.prev` that does not match the SHA-256 of the line before it shows that a line was
removed or changed after it was written. The sequence restarts at 1 with a new
`budgetpilot.log.boot_id` at every start.

The chain has no key, so what it detects is narrow. It shows a line removed from inside one
process's run, and a line edited without recomputing the hashes after it, accidentally or by
someone who did not bother. It does not show an edit followed by recomputing every later hash, a
run whose last lines were cut off, or a whole run removed, because nothing records how many lines
a run wrote. The real boundary is a copy held somewhere the host cannot reach: ship the log to a
collector on another machine.

## How long logs are kept

The application writes standard output and cannot delete what the container runtime keeps. Every
service the shipped Compose files start is set to Docker's `json-file` driver keeping at most five
files of 10 MB (`docker-compose.keys.yml` and `docker-compose.ai.gpu.yml` only extend a service
another file defines, and inherit its setting), which bounds the log by SIZE, not by age: the driver has no option that deletes by
age. To change the bound, set `logging:` in your own Compose override.

If you ship the log to a collector, set the retention there. The CNIL's recommendation on logging
(Délibération n° 2021-122, paragraph 8,
[recommandation_-_journalisation.pdf](https://www.cnil.fr/sites/default/files/atoms/files/recommandation_-_journalisation.pdf))
reads: « La Commission recommande de conserver ces données pendant une durée comprise entre six mois
et un an. » A year is the ceiling to set; the recommendation is not binding.

## Settings

| Variable          | Values                  | Default | Effect                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BP_LOG_LEVEL`    | `debug`, `info`, `warn` | `info`  | Lines below this severity are not written. There is no `error` level: `sys_startup`, `sys_monitor_disabled`, `sys_crash` and every `budgetpilot.config.*` event are `WARN` or above and cannot be silenced                                              |
| `BP_SECURITY_LOG` | `on`, `off`             | `on`    | `off` drops the authentication, authorization and control-bypass events, and writes `sys_monitor_disabled` at every start while it is off. No such event exists yet in this version; [#250](https://github.com/NonoHM/budgetpilot/issues/250) adds them |

A value outside the list stops the server at start with a message naming the allowed values. A value
other than the default is written at start.

## The client address

No event in this version carries a client address. When the authentication events arrive
([#250](https://github.com/NonoHM/budgetpilot/issues/250)), they carry it only as an HMAC-SHA256
under a key derived from `RATE_LIMIT_HASH_SECRET`, never in clear and never truncated, and only on
authentication events and on the rate limiter's refusal of an authentication attempt. The derivation
uses its own label, so a logged value never equals the hash the rate limiter stores in the database.

Whoever holds `.env` can recover a logged IPv4 address by trying every address, because there are
only about four billion. The hash protects the address from every other reader of the log: a
collector, a monitoring tool, a copy that leaks. Rotating `RATE_LIMIT_HASH_SECRET` changes every
hash, so addresses logged before and after the rotation can no longer be matched.

## Sending the log to a collector

The application guarantees what most collectors need: one JSON object per line, flat scalar values
only, each line under 8192 bytes, and no field renamed in place (a renamed field is a new field).
Converting to another format, such as OCSF, ECS, CEF or RFC 5424 syslog, is the collector's job.
Read the lines with your collector's JSON parser and keep the lines it cannot parse: they are
`prisma migrate deploy`'s output at start.

## Every event

This section is written by hand from `src/lib/server/logging/events.ts`, and `logInventory.spec.ts`
fails when the two disagree on any event, severity, sentence, attribute or level.

« Summarised when repeated » marks an event a visitor can cause without signing in. Within a minute,
the first 20 lines with the same event, status, route template and error class are written, the rest
are counted, and when the minute ends one `budgetpilot.log.suppressed` line gives the count with
that event, status, route and class. That line belongs to no request, so it carries no `trace_id`.

**Under a flood, an error reference can be missing.** If a visitor reports a reference you cannot
find, look for a `budgetpilot.log.suppressed` line in the minute they name: its route and error class
identify the failures that were counted instead of written. A failure on another route, or of
another class, has its own window and is still written.

### `sys_startup`

Severity WARN.

> BudgetPilot started. The attributes are the security-relevant configuration it started with.

| Attribute                                 | Level       |
| ----------------------------------------- | ----------- |
| `service.version`                         | Operational |
| `budgetpilot.config.public_instance`      | Operational |
| `budgetpilot.config.cookies_secure`       | Operational |
| `budgetpilot.config.database_provider`    | Operational |
| `budgetpilot.config.trusted_proxy_ranges` | Operational |
| `budgetpilot.config.origin_set`           | Operational |
| `budgetpilot.config.security_log`         | Operational |
| `budgetpilot.config.log_level`            | Operational |

### `sys_crash`

Severity FATAL.

> BudgetPilot stopped on an error nothing caught. It exits with status 1.

| Attribute                            | Level       |
| ------------------------------------ | ----------- |
| `error.type`                         | Operational |
| `budgetpilot.error.code`             | Operational |
| `budgetpilot.error.operator_message` | Operational |
| `budgetpilot.crash.origin`           | Operational |

### `sys_monitor_disabled`

Severity WARN.

> Security event logging is off (BP_SECURITY_LOG=off): authentication, authorization and control-bypass events are not written.

| Attribute             | Level       |
| --------------------- | ----------- |
| `budgetpilot.monitor` | Operational |

### `budgetpilot.config.origin_set`

Severity WARN.

> Form submissions are accepted only from this exact origin. If it is not the URL you type in the browser, protocol and port included, every sign-in is refused as cross-site.

| Attribute                   | Level       |
| --------------------------- | ----------- |
| `budgetpilot.config.origin` | Operational |

### `budgetpilot.config.origin_unset`

Severity WARN.

> ORIGIN is unset, so on a plain-http deployment every form submission fails as cross-site while pages still load. Set ORIGIN to the exact URL you type in the browser (docs/troubleshooting.md).

No attributes beyond the envelope.

### `budgetpilot.config.trusted_proxies_unset`

Severity WARN.

> TRUSTED_PROXIES is unset, so X-Forwarded-For is not trusted and rate limiting keys on the socket peer. Behind a reverse proxy, set it, or every visitor shares the proxy address (docs/reverse-proxy.md).

No attributes beyond the envelope.

### `budgetpilot.config.insecure_cookies`

Severity WARN.

> PUBLIC_INSTANCE=false: session cookies are sent without the Secure flag. Correct for a private instance on a trusted network over http, unsafe anywhere else.

No attributes beyond the envelope.

### `budgetpilot.config.bootstrap_token_empty`

Severity WARN.

> BOOTSTRAP_TOKEN is empty while REGISTRATION_MODE=admin_only: no account can be created except through an invitation link from the admin panel.

No attributes beyond the envelope.

### `budgetpilot.config.bound_changed`

Severity WARN.

> An operator bound differs from its default. docs/configuration.md says what the bound protects and what each direction costs.

| Attribute                                 | Level       |
| ----------------------------------------- | ----------- |
| `budgetpilot.config.name`                 | Operational |
| `budgetpilot.config.value`                | Operational |
| `budgetpilot.config.default`              | Operational |
| `budgetpilot.config.direction`            | Operational |
| `budgetpilot.config.below_honest_minimum` | Operational |

### `budgetpilot.config.log_level_changed`

Severity WARN.

> BP_LOG_LEVEL differs from its default of info.

| Attribute                      | Level       |
| ------------------------------ | ----------- |
| `budgetpilot.config.log_level` | Operational |

### `budgetpilot.request.failed`

Severity ERROR. Summarised when repeated.

> A request failed on an unexpected error. The error id is the reference the visitor was shown.

| Attribute                            | Level       |
| ------------------------------------ | ----------- |
| `error.type`                         | Operational |
| `budgetpilot.error.code`             | Operational |
| `budgetpilot.error.operator_message` | Operational |
| `http.response.status_code`          | Operational |
| `budgetpilot.error.id`               | Operational |

### `budgetpilot.request.not_found`

Severity INFO. Summarised when repeated.

> A request matched no page.

| Attribute                   | Level       |
| --------------------------- | ----------- |
| `http.response.status_code` | Operational |
| `budgetpilot.error.id`      | Operational |

### `budgetpilot.backfill.started`

Severity INFO.

> A one-time boot backfill started.

| Attribute                   | Level       |
| --------------------------- | ----------- |
| `budgetpilot.backfill.name` | Operational |

### `budgetpilot.backfill.progress`

Severity INFO.

> A one-time boot backfill is progressing.

| Attribute                      | Level       |
| ------------------------------ | ----------- |
| `budgetpilot.backfill.name`    | Operational |
| `budgetpilot.backfill.stage`   | Operational |
| `budgetpilot.backfill.count`   | Operational |
| `budgetpilot.backfill.pending` | Operational |

### `budgetpilot.backfill.completed`

Severity INFO.

> A one-time boot backfill completed.

| Attribute                                     | Level       |
| --------------------------------------------- | ----------- |
| `budgetpilot.backfill.name`                   | Operational |
| `budgetpilot.backfill.count`                  | Operational |
| `budgetpilot.backfill.unkeyed`                | Operational |
| `budgetpilot.backfill.batches_filed`          | Operational |
| `budgetpilot.backfill.users`                  | Operational |
| `budgetpilot.backfill.rows_merged`            | Operational |
| `budgetpilot.backfill.transactions_repointed` | Operational |

### `budgetpilot.backfill.lock_wait`

Severity INFO.

> Waiting for another instance to finish a one-time backfill.

| Attribute                             | Level       |
| ------------------------------------- | ----------- |
| `budgetpilot.backfill.name`           | Operational |
| `budgetpilot.backfill.waited_seconds` | Operational |

### `budgetpilot.backfill.merges_blocked`

Severity WARN.

> Some names now read as duplicates and were left untouched. Run scripts/normalize-names.mjs --dry-run to see which.

| Attribute                               | Level       |
| --------------------------------------- | ----------- |
| `budgetpilot.backfill.account_groups`   | Operational |
| `budgetpilot.backfill.net_worth_groups` | Operational |

### `budgetpilot.net_worth.links_withdrawn`

Severity WARN.

> Net worth accounts fed by more than one synchronized bank account had their links withdrawn (#501). Set the one that should feed each line again in Settings.

| Attribute                               | Level       |
| --------------------------------------- | ----------- |
| `budgetpilot.net_worth.lines_contested` | Operational |
| `budgetpilot.net_worth.links_withdrawn` | Operational |

### `budgetpilot.dates.check_failed`

Severity WARN.

> The check for rows dated before the storable range could not run; nothing was changed.

No attributes beyond the envelope.

### `budgetpilot.dates.outside_storable_range`

Severity WARN.

> Rows carry a date before the storable range (#758). They can display in the wrong century and a backup holding them is refused on restore. Nothing was changed.

| Attribute                               | Level       |
| --------------------------------------- | ----------- |
| `budgetpilot.dates.total`               | Operational |
| `budgetpilot.dates.counts`              | Operational |
| `budgetpilot.dates.first_storable_year` | Operational |

### `budgetpilot.database.overprivileged`

Severity WARN.

> The app connects to PostgreSQL with more privilege than it uses, including rights that run programs on the database host. docs/database-providers.md, "The app's database account", says how to reduce it.

| Attribute                             | Level       |
| ------------------------------------- | ----------- |
| `budgetpilot.database.owns_database`  | Operational |
| `budgetpilot.database.bootstrap_role` | Operational |

### `budgetpilot.bank.balance_fetch_failed`

Severity WARN.

> A bank balance fetch failed; the transactions of the same sync are kept.

| Attribute                        | Level       |
| -------------------------------- | ----------- |
| `budgetpilot.bank.connection_id` | Operational |
| `error.type`                     | Operational |
| `http.response.status_code`      | Operational |
| `budgetpilot.bank.provider_code` | Operational |

### `budgetpilot.rules.catalog_entry_skipped`

Severity WARN.

> A shipped default rule was skipped while loading the catalogue.

| Attribute                  | Level       |
| -------------------------- | ----------- |
| `budgetpilot.rules.reason` | Operational |
| `budgetpilot.rules.source` | Operational |
| `budgetpilot.rules.key`    | Operational |

### `budgetpilot.import.write_failed`

Severity ERROR.

> An import write step failed.

| Attribute                            | Level       |
| ------------------------------------ | ----------- |
| `error.type`                         | Operational |
| `budgetpilot.error.code`             | Operational |
| `budgetpilot.error.operator_message` | Operational |
| `budgetpilot.import.stage`           | Operational |
| `budgetpilot.import.landed_rows`     | Operational |
| `budgetpilot.error.cause_type`       | Operational |
| `budgetpilot.error.cause_code`       | Operational |

### `budgetpilot.import.account_not_remembered`

Severity WARN. Summarised when repeated.

> An answered import account could not be remembered; the import itself went through.

No attributes beyond the envelope.

### `budgetpilot.transactions.counts_unavailable`

Severity WARN. Summarised when repeated.

> Filter counts on the transactions page could not be computed; the page renders without them.

| Attribute                              | Level       |
| -------------------------------------- | ----------- |
| `budgetpilot.transactions.counts_kind` | Operational |
| `error.type`                           | Operational |

### `budgetpilot.boot.legacy_database_adopted`

Severity WARN.

> Using /data/dev.db, where this install's database already is. Nothing was moved. To adopt /data/budgetpilot.db, stop the container and rename the file and its -wal and -shm siblings; to keep the old name, set DATABASE_URL=file:/data/dev.db.

No attributes beyond the envelope.

### `budgetpilot.boot.data_dir_read_only`

Severity FATAL.

> The SQLite directory is on a read-only filesystem. The container runs with a read-only root by design and the directory must be a mounted volume: in Compose the budgetpilot_data:/data volume, with docker run -v budgetpilot_data:/data. DATABASE_URL must point inside /data.

| Attribute                    | Level       |
| ---------------------------- | ----------- |
| `budgetpilot.boot.directory` | Operational |

### `budgetpilot.boot.data_dir_not_writable`

Severity FATAL.

> The SQLite directory is not writable by this uid. After an upgrade from an image older than the distroless one, the volume is still owned by the old uid: with the container stopped, find the volume with docker volume ls, then docker run --rm -v <that name>:/data busybox chown -R 65532:65532 /data.

| Attribute                    | Level       |
| ---------------------------- | ----------- |
| `budgetpilot.boot.directory` | Operational |
| `budgetpilot.boot.uid`       | Operational |

### `budgetpilot.boot.data_dir_unusable`

Severity FATAL.

> The SQLite directory could not be written, so the app cannot start.

| Attribute                    | Level       |
| ---------------------------- | ----------- |
| `budgetpilot.boot.directory` | Operational |
| `budgetpilot.boot.uid`       | Operational |
| `budgetpilot.error.code`     | Operational |

### `budgetpilot.boot.migrate_failed`

Severity FATAL.

> prisma migrate deploy failed, so the app refuses to start. Its own output is above this line.

| Attribute                    | Level       |
| ---------------------------- | ----------- |
| `budgetpilot.boot.exit_code` | Operational |

### `budgetpilot.log.suppressed`

Severity WARN.

> Repeats of one event were summarised instead of written, so the log cannot be used to fill the disk.

| Attribute                               | Level       |
| --------------------------------------- | ----------- |
| `budgetpilot.log.suppressed_event`      | Operational |
| `budgetpilot.log.suppressed_count`      | Operational |
| `budgetpilot.log.window_seconds`        | Operational |
| `budgetpilot.log.suppressed_status`     | Operational |
| `budgetpilot.log.suppressed_route`      | Operational |
| `budgetpilot.log.suppressed_error_type` | Operational |

### `budgetpilot.log.line_too_long`

Severity WARN.

> A line exceeded the size a collector accepts, so its attributes were dropped.

| Attribute                          | Level       |
| ---------------------------------- | ----------- |
| `budgetpilot.log.suppressed_event` | Operational |
| `budgetpilot.log.dropped_bytes`    | Operational |

### `budgetpilot.console.output`

Severity WARN. Summarised when repeated.

> A dependency wrote to the console. The text is what it printed, capped and escaped.

| Attribute                    | Level       |
| ---------------------------- | ----------- |
| `budgetpilot.console.method` | Operational |
| `budgetpilot.console.text`   | Operational |

---

If you use an instance someone else runs, [what the security log records about you](./using/security-logging.md)
is the page written for you.
