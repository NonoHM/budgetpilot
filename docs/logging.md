# Logs

**Audience:** whoever runs the instance, and contributors who add a log line. **Type:**
reference.

Every line BudgetPilot itself writes is one JSON object on standard output: no file, no network
destination. Two streams reach the container's output and are not JSON (some of the first on the error stream, 3 lines of 183 in a measured start): what `prisma migrate deploy`
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

When a request fails inside a page's load or action, the error page shows the visitor a reference.
That reference is the line's `budgetpilot.error.id`, and the same value without its dashes is the
`trace_id`. A failure thrown earlier, in the server's `handle` step, shows SvelteKit's plain
« 500 Internal Error » page with no reference, and its line carries a different error id, no
`trace_id`, no method and no route (measured on this build; filed as [#873](https://github.com/NonoHM/budgetpilot/issues/873)).

### What a field may contain

No field carries text a visitor or a remote host chose. Each is a closed set of values, a number, a
boolean, an identifier the server generated, a value checked against a pattern (an error class or
code), or text the application or its operator wrote: the configured `ORIGIN`, the message of a
refusal written for the operator, the name of a shipped rule file. The one exception is
`budgetpilot.console.text`, which is what a dependency printed: nobody chose that text, so it is
not classified, like the output of `prisma migrate deploy`.

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
files of 10 MB (`docker-compose.keys.yml`, `docker-compose.ai.gpu.yml` and `docker-compose.ai.offline.yml` only
extend a service another file defines, and inherit its setting), which bounds the log by SIZE, not by age: the driver has no option that deletes by
age. To change the bound, set `logging:` in your own Compose override.

If you ship the log to a collector, set the retention there. The CNIL's recommendation on logging
(Délibération n° 2021-122, paragraph 8,
[recommandation_-_journalisation.pdf](https://www.cnil.fr/sites/default/files/atoms/files/recommandation_-_journalisation.pdf))
reads: « La Commission recommande de conserver ces données pendant une durée comprise entre six mois
et un an. » A year is the ceiling to set; the recommendation is not binding.

## Settings

| Variable          | Values                  | Default | Effect                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BP_LOG_LEVEL`    | `debug`, `info`, `warn` | `info`  | Lines below this severity are not written. There is no `error` level: `sys_startup`, `sys_monitor_disabled`, `sys_crash` and every `budgetpilot.config.*` event are `WARN` or above and cannot be silenced                                                                                                                                                                                 |
| `BP_SECURITY_LOG` | `on`, `off`             | `on`    | `off` drops the authentication, authorization-failure and control-bypass events, and writes `sys_monitor_disabled` at every start while it is off. The control-bypass events are the rate limiter's refusals, every kind, and `budgetpilot.redirect.refused`. A record of an admin action, such as `authz_admin` or `budgetpilot.ai.inference_halted`, is not a security event and is kept |

A value outside the list stops the server at start with a message naming the allowed values. A value
other than the default is written at start.

## The client address and the account

The authentication and authorization events identify the client and the account only by keyed hashes, HMAC-SHA256
under keys derived from `RATE_LIMIT_HASH_SECRET`, each under its own label. No line carries an IP
address, an email address or a user id in clear.

| Field                                 | What is hashed                                                                                                                                 | On which events                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `budgetpilot.client.pseudonym`        | The client's address, in one canonical spelling.                                                                                               | Every authentication event except `session_logout`, `budgetpilot.session.invalid` and `crypt_decrypt_fail`.                  |
| `budgetpilot.client.subnet_pseudonym` | The network the rate limiter counts the client in: the address itself for IPv4, its `BP_RATE_LIMIT_IPV6_PREFIX` prefix for IPv6.               | Only `authn_login_fail`, `budgetpilot.authn.reauth_fail` and `excess_rate_limit_exceeded`.                                   |
| `budgetpilot.user.pseudonym`          | The account's user id.                                                                                                                         | Every authentication event that concerns a known account, both authorization events, and the admin who halted or resumed AI. |
| `budgetpilot.target.user_pseudonym`   | The user id of the account an admin action acted on, under the same key as `budgetpilot.user.pseudonym`, so that account's own lines match it. | `authz_admin`, for `delete_user`, `reset_password` and `create_account` only.                                                |

`budgetpilot.client.subnet_prefix_length` is written beside the subnet label: `32` for an IPv4
client, the prefix for IPv6. When you change `BP_RATE_LIMIT_IPV6_PREFIX`, every IPv6 label changes,
and this field tells you why.

The subnet label groups the changing addresses of one IPv6 household, which is what you need to
recognise one attacker rotating through its own block. It is written only on the three events that
signal an attack, never on a successful sign-in, a sign-out or a session event, so an honest
household is grouped only when it trips something (data minimisation,
[#936](https://github.com/NonoHM/budgetpilot/issues/936)).

Whoever holds `.env` can recover a logged IPv4 address by trying every address, because there are
only about four billion, and can recompute the pseudonym of any user id they know. The hashes
protect against every other reader of the log: a collector, a monitoring tool, a copy that leaks.
The labels differ, so a logged value never equals the hash the rate limiter stores in the database,
and a line cannot be joined to a database row without the secret. Rotating `RATE_LIMIT_HASH_SECRET`
changes every hash, so lines written before and after the rotation can no longer be matched.
[Find the account or address behind a pseudonym](./logging-howto.md#find-the-account-or-address-behind-a-pseudonym)
does that computation for you, including under a previous secret.

**A tool that blocks addresses cannot act on a hash.** fail2ban, CrowdSec or a Wazuh active response
needs the address in clear. Detect on this log, where the same client or subnet gives the same hash,
and block on the web server's access log, which keeps the address readable on purpose
(`Caddyfile.example`). BudgetPilot marks each refused sign-in with a `BudgetPilot-Sign-In: refused`
response header, which the access log records beside the address:
[Ban an address after failed sign-ins](./ban-failed-sign-ins.md) has the fail2ban and CrowdSec
recipes.

## Sending the log to a collector

The application guarantees what most collectors need: one JSON object per line, flat scalar values
only, each line under 8192 bytes, and no field renamed in place (a renamed field is a new field).
Converting to another format, such as OCSF, ECS, CEF or RFC 5424 syslog, is the collector's job.
Read the lines with your collector's JSON parser and keep the lines it cannot parse: they are
`prisma migrate deploy`'s output at start.

## Every field

Every name a line can carry, from `src/lib/server/logging/names.ts`. `logInventory.spec.ts` fails when
a name has no row, when a row has no name, and when a row gives a level the registry does not.
Values are written as JSON writes them: strings in quotes, numbers and booleans without. A field a
line does not carry is absent, not empty.

| Field                                         | Meaning                                                                                                                                                                                                           | Type    | Values                                                                                                                                                                                                                                                            | Example                                                              | Level          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------- |
| `timestamp`                                   | When the line was written, in UTC. As accurate as the host clock.                                                                                                                                                 | string  | ISO 8601 with milliseconds and a `Z`                                                                                                                                                                                                                              | `"2026-10-03T16:35:36.164Z"`                                         | Operational    |
| `severity_text`                               | How important the line is, as a word.                                                                                                                                                                             | string  | `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`                                                                                                                                                                                                                         | `"WARN"`                                                             | Operational    |
| `severity_number`                             | The same importance as a number, on OpenTelemetry's scale.                                                                                                                                                        | number  | 5, 9, 13, 17 or 21                                                                                                                                                                                                                                                | `13`                                                                 | Operational    |
| `event_name`                                  | What happened. One of the events listed under « Every event ».                                                                                                                                                    | string  | a name from « Every event »                                                                                                                                                                                                                                       | `"budgetpilot.request.not_found"`                                    | Operational    |
| `body`                                        | One fixed English sentence for the event, never built from data.                                                                                                                                                  | string  | the sentence of the event                                                                                                                                                                                                                                         | `"A request matched no page."`                                       | Operational    |
| `trace_id`                                    | Identifies one request, so its lines can be found together. Generated by the server.                                                                                                                              | string  | 32 lowercase hexadecimal characters                                                                                                                                                                                                                               | `"d93714c70d294d01ac558ec80d25bdf9"`                                 | Operational    |
| `service.name`                                | Which program wrote the line.                                                                                                                                                                                     | string  | always `budgetpilot`                                                                                                                                                                                                                                              | `"budgetpilot"`                                                      | Operational    |
| `service.version`                             | The version of BudgetPilot that wrote the line.                                                                                                                                                                   | string  | a version number                                                                                                                                                                                                                                                  | `"1.2.0"`                                                            | Operational    |
| `http.request.method`                         | The kind of request being handled.                                                                                                                                                                                | string  | a standard method, or `_OTHER`                                                                                                                                                                                                                                    | `"GET"`                                                              | Operational    |
| `http.route`                                  | The page being handled, as a template. Absent when no page matched.                                                                                                                                               | string  | a route template of the application                                                                                                                                                                                                                               | `"/imports/[batchId]"`                                               | Operational    |
| `http.response.status_code`                   | The HTTP status the visitor received.                                                                                                                                                                             | number  | a status code, 400 to 599 in practice                                                                                                                                                                                                                             | `500`                                                                | Operational    |
| `error.type`                                  | The class of an error, never its message.                                                                                                                                                                         | string  | a class name, letters, digits and `_`, at most 64; or one of `http_error`, `sync_failed` on a bank balance failure                                                                                                                                                | `"PrismaClientKnownRequestError"`                                    | Operational    |
| `budgetpilot.log.schema`                      | The version of these field names.                                                                                                                                                                                 | number  | always `1` for now                                                                                                                                                                                                                                                | `1`                                                                  | Operational    |
| `budgetpilot.log.boot_id`                     | Identifies one start of the server. A restart gives a new one.                                                                                                                                                    | string  | a UUID                                                                                                                                                                                                                                                            | `"3b0e9a4c-5d1f-4c8e-9a62-0f7d2b8e41aa"`                             | Operational    |
| `budgetpilot.log.seq`                         | The line's number within its start.                                                                                                                                                                               | number  | 1, then one more per line                                                                                                                                                                                                                                         | `5`                                                                  | Operational    |
| `budgetpilot.log.prev`                        | Fingerprint of the previous line, to detect a removed or edited line.                                                                                                                                             | string  | 64 hexadecimal characters; 64 zeros on the first line                                                                                                                                                                                                             | `"3166300d2aed0566661346da6d8280b970aadc0d5447bceb29225f09d1ce157a"` | Operational    |
| `budgetpilot.error.code`                      | The error's code, such as a database error code.                                                                                                                                                                  | string  | capital letters, digits and `_`, 1 to 40 characters                                                                                                                                                                                                               | `"P2021"`                                                            | Operational    |
| `budgetpilot.error.id`                        | The reference shown to the visitor on the error page. Same value as `trace_id`, with dashes.                                                                                                                      | string  | a UUID                                                                                                                                                                                                                                                            | `"3b0e9a4c-5d1f-4c8e-9a62-0f7d2b8e41aa"`                             | Operational    |
| `budgetpilot.error.operator_message`          | A message the application wrote for the operator, when the error was one it raised on purpose.                                                                                                                    | string  | text from the code, at most 2048 characters                                                                                                                                                                                                                       | `"DATABASE_URL must point inside /data"`                             | Operational    |
| `budgetpilot.error.cause_type`                | The class of the error that caused an import write to fail.                                                                                                                                                       | string  | a class name, as for `error.type`                                                                                                                                                                                                                                 | `"PrismaClientKnownRequestError"`                                    | Operational    |
| `budgetpilot.error.cause_code`                | The code of that causing error.                                                                                                                                                                                   | string  | as for `budgetpilot.error.code`                                                                                                                                                                                                                                   | `"P2003"`                                                            | Operational    |
| `budgetpilot.crash.origin`                    | Which kind of uncaught failure stopped the server.                                                                                                                                                                | string  | `uncaughtException`, `unhandledRejection`                                                                                                                                                                                                                         | `"unhandledRejection"`                                               | Operational    |
| `budgetpilot.config.public_instance`          | Whether the instance expects HTTPS (`secure`) or runs on a trusted network over http (`lan`).                                                                                                                     | string  | `secure`, `lan`                                                                                                                                                                                                                                                   | `"secure"`                                                           | Operational    |
| `budgetpilot.config.cookies_secure`           | Whether sign-in cookies travel only over HTTPS.                                                                                                                                                                   | boolean | `true`, `false`                                                                                                                                                                                                                                                   | `true`                                                               | Operational    |
| `budgetpilot.config.database_provider`        | The database in use.                                                                                                                                                                                              | string  | `sqlite`, `postgresql`, `mysql`                                                                                                                                                                                                                                   | `"sqlite"`                                                           | Operational    |
| `budgetpilot.config.trusted_proxy_ranges`     | How many reverse-proxy address ranges `TRUSTED_PROXIES` declares.                                                                                                                                                 | number  | zero or more                                                                                                                                                                                                                                                      | `0`                                                                  | Operational    |
| `budgetpilot.config.origin_set`               | Whether `ORIGIN` is set.                                                                                                                                                                                          | boolean | `true`, `false`                                                                                                                                                                                                                                                   | `true`                                                               | Operational    |
| `budgetpilot.config.origin`                   | The configured `ORIGIN`, the address people type in the browser.                                                                                                                                                  | string  | the operator's own URL                                                                                                                                                                                                                                            | `"http://localhost:3000"`                                            | Operational    |
| `budgetpilot.config.security_log`             | The state of `BP_SECURITY_LOG`.                                                                                                                                                                                   | string  | `on`, `off`, `refused` (a value outside the list)                                                                                                                                                                                                                 | `"on"`                                                               | Operational    |
| `budgetpilot.config.log_level`                | The state of `BP_LOG_LEVEL`.                                                                                                                                                                                      | string  | `debug`, `info`, `warn`, `refused` (a value outside the list)                                                                                                                                                                                                     | `"info"`                                                             | Operational    |
| `budgetpilot.config.name`                     | Which operator bound differs from its default.                                                                                                                                                                    | string  | `IMPORT_RATE_LIMIT_MAX_ATTEMPTS`, `BACKUP_MAX_JSON_NODES`, `CSV_MAX_COLUMNS`, `COLUMN_MAPPINGS_PER_USER`, `IMPORT_XLSX_MAX_UNCOMPRESSED_MB`                                                                                                                       | `"CSV_MAX_COLUMNS"`                                                  | Operational    |
| `budgetpilot.config.value`                    | The value the operator set for that bound.                                                                                                                                                                        | number  | a whole number                                                                                                                                                                                                                                                    | `200`                                                                | Operational    |
| `budgetpilot.config.default`                  | The default of that bound.                                                                                                                                                                                        | number  | a whole number                                                                                                                                                                                                                                                    | `100`                                                                | Operational    |
| `budgetpilot.config.direction`                | Whether the operator raised or lowered the bound.                                                                                                                                                                 | string  | `raised`, `lowered`                                                                                                                                                                                                                                               | `"raised"`                                                           | Operational    |
| `budgetpilot.config.below_honest_minimum`     | Whether the value is below the smallest value that still works for a normal user.                                                                                                                                 | boolean | `true`, `false`                                                                                                                                                                                                                                                   | `false`                                                              | Operational    |
| `budgetpilot.config.file_mode`                | The permission bits of `.env`, in octal.                                                                                                                                                                          | string  | three octal digits                                                                                                                                                                                                                                                | `"644"`                                                              | Operational    |
| `budgetpilot.config.model_host`               | The host name in `LLM_BASE_URL`, which the operator wrote.                                                                                                                                                        | string  | a host name                                                                                                                                                                                                                                                       | `"models.example.test"`                                              | Operational    |
| `budgetpilot.monitor`                         | Which monitoring is switched off.                                                                                                                                                                                 | string  | always `security_log`                                                                                                                                                                                                                                             | `"security_log"`                                                     | Operational    |
| `budgetpilot.backfill.name`                   | Which one-time boot upgrade of stored data is running.                                                                                                                                                            | string  | `name_keys`, `dedupe_key_hashes`, `dedupe_key_recompute`, `statement_accounts`                                                                                                                                                                                    | `"name_keys"`                                                        | Operational    |
| `budgetpilot.backfill.stage`                  | The step of that upgrade.                                                                                                                                                                                         | string  | `keys`, `accounts_named`, `batches_filed`                                                                                                                                                                                                                         | `"keys"`                                                             | Operational    |
| `budgetpilot.backfill.count`                  | How many rows that step handled.                                                                                                                                                                                  | number  | zero or more                                                                                                                                                                                                                                                      | `420`                                                                | Operational    |
| `budgetpilot.backfill.pending`                | How many rows are still to do.                                                                                                                                                                                    | number  | zero or more                                                                                                                                                                                                                                                      | `1200`                                                               | Operational    |
| `budgetpilot.backfill.unkeyed`                | How many rows still have no key after the upgrade.                                                                                                                                                                | number  | zero or more                                                                                                                                                                                                                                                      | `0`                                                                  | Operational    |
| `budgetpilot.backfill.batches_filed`          | How many import batches were filed.                                                                                                                                                                               | number  | zero or more                                                                                                                                                                                                                                                      | `3`                                                                  | Operational    |
| `budgetpilot.backfill.users`                  | How many users the upgrade touched.                                                                                                                                                                               | number  | zero or more                                                                                                                                                                                                                                                      | `2`                                                                  | Operational    |
| `budgetpilot.backfill.rows_merged`            | How many duplicate rows were merged.                                                                                                                                                                              | number  | zero or more                                                                                                                                                                                                                                                      | `0`                                                                  | Operational    |
| `budgetpilot.backfill.transactions_repointed` | How many transactions were moved to a surviving row.                                                                                                                                                              | number  | zero or more                                                                                                                                                                                                                                                      | `0`                                                                  | Operational    |
| `budgetpilot.backfill.waited_seconds`         | How long this start has waited for another instance to finish an upgrade.                                                                                                                                         | number  | seconds, zero or more                                                                                                                                                                                                                                             | `30`                                                                 | Operational    |
| `budgetpilot.backfill.account_groups`         | How many groups of accounts now have the same name and were left alone.                                                                                                                                           | number  | zero or more                                                                                                                                                                                                                                                      | `1`                                                                  | Operational    |
| `budgetpilot.backfill.net_worth_groups`       | How many groups of net worth lines now have the same name and were left alone.                                                                                                                                    | number  | zero or more                                                                                                                                                                                                                                                      | `0`                                                                  | Operational    |
| `budgetpilot.net_worth.lines_contested`       | How many net worth lines were fed by more than one synchronized bank account.                                                                                                                                     | number  | zero or more                                                                                                                                                                                                                                                      | `2`                                                                  | Operational    |
| `budgetpilot.net_worth.links_withdrawn`       | How many of those links were withdrawn.                                                                                                                                                                           | number  | zero or more                                                                                                                                                                                                                                                      | `4`                                                                  | Operational    |
| `budgetpilot.dates.total`                     | How many rows carry a date before the storable range.                                                                                                                                                             | number  | zero or more                                                                                                                                                                                                                                                      | `12`                                                                 | Operational    |
| `budgetpilot.dates.counts`                    | That count per table column.                                                                                                                                                                                      | string  | `column=count` pairs joined by commas, column names from the schema                                                                                                                                                                                               | `"Transaction.date=12"`                                              | Operational    |
| `budgetpilot.dates.first_storable_year`       | The first year the application can store.                                                                                                                                                                         | number  | a year                                                                                                                                                                                                                                                            | `1900`                                                               | Operational    |
| `budgetpilot.database.owns_database`          | Whether the app's PostgreSQL role owns the database.                                                                                                                                                              | boolean | `true`, `false`                                                                                                                                                                                                                                                   | `true`                                                               | Operational    |
| `budgetpilot.database.bootstrap_role`         | Whether the app connects as the role that created the server.                                                                                                                                                     | boolean | `true`, `false`                                                                                                                                                                                                                                                   | `true`                                                               | Operational    |
| `budgetpilot.bank.connection_id`              | Identifies the bank connection whose balance fetch failed. An internal identifier, not an account number.                                                                                                         | string  | an identifier the application generated                                                                                                                                                                                                                           | `"cm1x7q2k90000abcd1234efgh"`                                        | Operational    |
| `budgetpilot.bank.provider_code`              | The error code the bank provider returned, when it returned one in the shape of a code.                                                                                                                           | string  | a code, letters, digits and `_`                                                                                                                                                                                                                                   | `"ASPSP_ERROR"`                                                      | Operational    |
| `budgetpilot.rules.reason`                    | Why a shipped default rule was skipped.                                                                                                                                                                           | string  | `invalid_schema`, `duplicate_key`, `dangerous_regex`                                                                                                                                                                                                              | `"duplicate_key"`                                                    | Operational    |
| `budgetpilot.rules.source`                    | The shipped rule file that held the skipped rule.                                                                                                                                                                 | string  | a file name from the application's own catalogue                                                                                                                                                                                                                  | `"groceries.json"`                                                   | Operational    |
| `budgetpilot.rules.key`                       | The key of the skipped rule, when it had a valid one.                                                                                                                                                             | string  | a key from the shipped catalogue                                                                                                                                                                                                                                  | `"groceries.supermarket"`                                            | Operational    |
| `budgetpilot.import.stage`                    | Which step of an import failed.                                                                                                                                                                                   | string  | `batch`, `rows`, `cleanup`                                                                                                                                                                                                                                        | `"rows"`                                                             | Operational    |
| `budgetpilot.import.landed_rows`              | How many rows had been written when it failed.                                                                                                                                                                    | number  | zero or more                                                                                                                                                                                                                                                      | `40`                                                                 | Operational    |
| `budgetpilot.transactions.counts_kind`        | Which filter count could not be computed.                                                                                                                                                                         | string  | `tags`, `splits`                                                                                                                                                                                                                                                  | `"tags"`                                                             | Operational    |
| `budgetpilot.boot.directory`                  | The data directory the container start found unusable.                                                                                                                                                            | string  | the directory taken from `DATABASE_URL`, the operator's own path                                                                                                                                                                                                  | `"/data"`                                                            | Operational    |
| `budgetpilot.boot.uid`                        | The user id the server runs as.                                                                                                                                                                                   | number  | a user id                                                                                                                                                                                                                                                         | `65532`                                                              | Operational    |
| `budgetpilot.boot.exit_code`                  | The exit code of `prisma migrate deploy`.                                                                                                                                                                         | number  | a process exit code                                                                                                                                                                                                                                               | `1`                                                                  | Operational    |
| `budgetpilot.boot.database_bytes`             | The size of `/data/budgetpilot.db`, when it and `/data/dev.db` both hold a database.                                                                                                                              | number  | a size in bytes                                                                                                                                                                                                                                                   | `593920`                                                             | Operational    |
| `budgetpilot.boot.legacy_database_bytes`      | The size of `/data/dev.db`, in the same case.                                                                                                                                                                     | number  | a size in bytes                                                                                                                                                                                                                                                   | `8417280`                                                            | Operational    |
| `budgetpilot.log.suppressed_event`            | The event whose repeats were counted instead of written, or the event whose line was too long.                                                                                                                    | string  | an event name from « Every event »                                                                                                                                                                                                                                | `"budgetpilot.request.not_found"`                                    | Operational    |
| `budgetpilot.log.suppressed_count`            | How many repeats were counted.                                                                                                                                                                                    | number  | one or more                                                                                                                                                                                                                                                       | `6`                                                                  | Operational    |
| `budgetpilot.log.window_seconds`              | The length of the counting window.                                                                                                                                                                                | number  | seconds; 60                                                                                                                                                                                                                                                       | `60`                                                                 | Operational    |
| `budgetpilot.log.suppressed_route`            | The route template of the counted repeats, when they had one.                                                                                                                                                     | string  | a route template of the application                                                                                                                                                                                                                               | `"/net-worth"`                                                       | Operational    |
| `budgetpilot.log.suppressed_error_type`       | The error class of the counted repeats, when they had one.                                                                                                                                                        | string  | a class name, as for `error.type`                                                                                                                                                                                                                                 | `"PrismaClientKnownRequestError"`                                    | Operational    |
| `budgetpilot.log.suppressed_status`           | The HTTP status of the counted repeats, when they had one.                                                                                                                                                        | number  | a status code                                                                                                                                                                                                                                                     | `404`                                                                | Operational    |
| `budgetpilot.log.dropped_bytes`               | How many bytes of a too-long line were dropped.                                                                                                                                                                   | number  | one or more                                                                                                                                                                                                                                                       | `9100`                                                               | Operational    |
| `budgetpilot.console.method`                  | Which console function a dependency used.                                                                                                                                                                         | string  | `log`, `info`, `debug`, `warn`, `error`, `trace`, `dir`                                                                                                                                                                                                           | `"log"`                                                              | Operational    |
| `budgetpilot.console.text`                    | What a dependency printed. Nobody at BudgetPilot chose this text.                                                                                                                                                 | string  | free text, cut at 256 characters and escaped                                                                                                                                                                                                                      | `"Listening on http://0.0.0.0:3000"`                                 | Not classified |
| `budgetpilot.user.pseudonym`                  | The account an authentication or authorization event concerns, the admin who carried out an admin action, or the admin who halted or resumed AI, as a keyed hash of its user id. Absent when there is no account. | string  | 64 lowercase hexadecimal characters                                                                                                                                                                                                                               | `"5f1c0e9d2a7b4c63e8f10a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f"` | Pseudonymous   |
| `budgetpilot.client.pseudonym`                | The client's address, as a keyed hash of its canonical spelling.                                                                                                                                                  | string  | 64 lowercase hexadecimal characters                                                                                                                                                                                                                               | `"5f1c0e9d2a7b4c63e8f10a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f"` | Pseudonymous   |
| `budgetpilot.client.subnet_pseudonym`         | The network the rate limiter counts the client in, as a keyed hash. Only on events that signal an attack.                                                                                                         | string  | 64 lowercase hexadecimal characters                                                                                                                                                                                                                               | `"5f1c0e9d2a7b4c63e8f10a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f"` | Pseudonymous   |
| `budgetpilot.client.subnet_prefix_length`     | The width of the network the subnet label was computed at.                                                                                                                                                        | number  | `32` for IPv4; for IPv6, the value of `BP_RATE_LIMIT_IPV6_PREFIX`                                                                                                                                                                                                 | `56`                                                                 | Operational    |
| `budgetpilot.authn.step`                      | Where a sign-in failed.                                                                                                                                                                                           | string  | `password`, `second_factor`                                                                                                                                                                                                                                       | `"password"`                                                         | Operational    |
| `budgetpilot.authn.reason`                    | Why an authentication attempt failed. The values depend on the event; « Every event » lists them.                                                                                                                 | string  | a closed list per event                                                                                                                                                                                                                                           | `"wrong_password"`                                                   | Operational    |
| `budgetpilot.authn.factor`                    | What completed a sign-in.                                                                                                                                                                                         | string  | `password`, `totp`, `recovery_code`                                                                                                                                                                                                                               | `"totp"`                                                             | Operational    |
| `budgetpilot.authn.method`                    | How an account was created.                                                                                                                                                                                       | string  | `bootstrap`, `backfill`, `open`, `invitation`                                                                                                                                                                                                                     | `"invitation"`                                                       | Operational    |
| `budgetpilot.authn.action`                    | The sensitive action a re-authentication was for.                                                                                                                                                                 | string  | an action listed under `budgetpilot.authn.reauth_success`                                                                                                                                                                                                         | `"changePassword"`                                                   | Operational    |
| `budgetpilot.ratelimit.kind`                  | Which limit refused the attempt: a sign-in step, an import or a bank connection.                                                                                                                                  | string  | `LOGIN`, `MFA`, `REGISTER`, `INVITE`, `REAUTH`, `IMPORT`, `BANK_SYNC_START`                                                                                                                                                                                       | `"LOGIN"`                                                            | Operational    |
| `budgetpilot.ratelimit.counter`               | Which counter of the refused attempt was full.                                                                                                                                                                    | string  | `address`, `subject`, `both`                                                                                                                                                                                                                                      | `"subject"`                                                          | Operational    |
| `budgetpilot.session.reason`                  | Why a session cookie no longer works.                                                                                                                                                                             | string  | `unknown`, `revoked`, `idle`, `expired`                                                                                                                                                                                                                           | `"idle"`                                                             | Operational    |
| `budgetpilot.crypt.purpose`                   | What the secret that did not decrypt is for.                                                                                                                                                                      | string  | `totp_secret`                                                                                                                                                                                                                                                     | `"totp_secret"`                                                      | Operational    |
| `budgetpilot.authz.reason`                    | Why a signed-in person was refused.                                                                                                                                                                               | string  | `not_found_or_not_owned`, `role_required`                                                                                                                                                                                                                         | `"not_found_or_not_owned"`                                           | Operational    |
| `budgetpilot.authz.reference`                 | The kind of reference that resolved to nothing the account may use. Only with `not_found_or_not_owned`, and never the reference itself.                                                                           | string  | `transaction`, `split_category`, `rule`, `category`, `tag`, `session`, `column_mapping`, `import_batch`, `account`, `net_worth_account`, `budget`, `savings_goal`, `bill_action`, `bank_connection`, `bank_authorization`, `remembered_account`, `nature_mapping` | `"transaction"`                                                      | Operational    |
| `budgetpilot.admin.action`                    | The admin action that was carried out.                                                                                                                                                                            | string  | `delete_user`, `reset_password`, `create_account`, `create_invitation`, `revoke_invitation`                                                                                                                                                                       | `"delete_user"`                                                      | Operational    |
| `budgetpilot.target.user_pseudonym`           | The account an admin action acted on, as a keyed hash of its user id under the key of `budgetpilot.user.pseudonym`. Only on the three actions that name an account.                                               | string  | 64 lowercase hexadecimal characters                                                                                                                                                                                                                               | `"5f1c0e9d2a7b4c63e8f10a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f"` | Pseudonymous   |
| `budgetpilot.redirect.reason`                 | Why the redirect guard refused to follow a redirect.                                                                                                                                                              | string  | `target_not_allowed`, `unresolvable_location`, `too_many_redirects`                                                                                                                                                                                               | `"target_not_allowed"`                                               | Operational    |
| `budgetpilot.redirect.upstream`               | Which outbound service sent the refused redirect.                                                                                                                                                                 | string  | `bank_provider`, `model_host`                                                                                                                                                                                                                                     | `"bank_provider"`                                                    | Operational    |

## What to do

Every event at `WARN`, `ERROR` or `FATAL`, and what it asks of the operator. An event at `INFO` or
below asks nothing.

| Event                                         | What it means and what to do                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sys_startup`                                 | Nothing to do on its own: it records the settings this start used. Read it first when something behaves unexpectedly.                                                                                                                                                                                                                                                                                                                      |
| `sys_crash`                                   | The server stopped. Read the lines just above for the class and code, fix the cause, and start it again. A restart policy restarts it, so repeated lines mean it is crash-looping.                                                                                                                                                                                                                                                         |
| `sys_monitor_disabled`                        | You turned security event logging off with `BP_SECURITY_LOG=off`. Nothing to do if that is intended; set it to `on` to get those events back.                                                                                                                                                                                                                                                                                              |
| `budgetpilot.config.origin_set`               | Nothing to do if the origin is the exact address you type in the browser, protocol and port included. If it is not, sign-ins are refused: correct `ORIGIN`.                                                                                                                                                                                                                                                                                |
| `budgetpilot.config.origin_unset`             | Set `ORIGIN` to the exact address you type in the browser. Until then, every form submission over plain http fails.                                                                                                                                                                                                                                                                                                                        |
| `budgetpilot.config.trusted_proxies_unset`    | Nothing to do without a reverse proxy. Behind one, set `TRUSTED_PROXIES`, or every visitor shares the proxy address for rate limiting.                                                                                                                                                                                                                                                                                                     |
| `budgetpilot.config.insecure_cookies`         | Nothing to do on a private instance on a trusted network over http. On anything reachable from outside, serve it over HTTPS and set `PUBLIC_INSTANCE=true`.                                                                                                                                                                                                                                                                                |
| `budgetpilot.config.bootstrap_token_empty`    | Nothing to do if you create accounts by invitation. Otherwise set `BOOTSTRAP_TOKEN`, because no one can register without it.                                                                                                                                                                                                                                                                                                               |
| `budgetpilot.config.bound_changed`            | Nothing to do if you changed the bound on purpose. `docs/configuration.md` says what each direction costs; `below_honest_minimum: true` means the value is too low for normal use.                                                                                                                                                                                                                                                         |
| `budgetpilot.config.log_level_changed`        | Nothing to do if you set `BP_LOG_LEVEL` on purpose. At `warn`, the informational lines, such as the page-not-found ones, are not written.                                                                                                                                                                                                                                                                                                  |
| `budgetpilot.config.env_file_exposed`         | Run `chmod 600 .env` in the directory the app starts from. Until then, any other account on this machine can read the secrets in it, and with a write bit set, change them.                                                                                                                                                                                                                                                                |
| `budgetpilot.config.model_host_remote`        | Nothing to do if you chose to run the model on that host. Otherwise point `LLM_BASE_URL` at a model server on this machine: until then, whatever a feature sends the model leaves it.                                                                                                                                                                                                                                                      |
| `budgetpilot.ai.inference_halted`             | Nothing to do if an admin halted AI on purpose. It stays halted across restarts until an admin resumes it on the admin page. An unexpected line means someone with an admin session pressed it.                                                                                                                                                                                                                                            |
| `budgetpilot.ai.inference_resumed`            | Nothing to do if an admin meant to resume AI. An unexpected line means someone holding an admin's session and password turned AI back on: halt it again, and ask that admin to change their password.                                                                                                                                                                                                                                      |
| `budgetpilot.request.failed`                  | A visitor met an error page. Find this line with the reference they were shown (the tutorial shows how), read the error class and code, and fix the cause. During a flood, look for a `budgetpilot.log.suppressed` line in the same minute.                                                                                                                                                                                                |
| `authn_login_fail`                            | Nothing to do for one line. Many from one `budgetpilot.client.pseudonym` or one subnet label in a few minutes is password guessing: block that client on the web server ([Ban an address after failed sign-ins](./ban-failed-sign-ins.md)). Many `wrong_password` for one user pseudonym from many clients is an attack on that account: tell its owner.                                                                                   |
| `excess_rate_limit_exceeded`                  | The rate limiter already refused the attempt. Read `budgetpilot.ratelimit.counter`: `address` points at the client, `subject` at an account or session someone else is attacking. For `IMPORT` or `BANK_SYNC_START`, many lines for one `budgetpilot.user.pseudonym` mean that member's session is being used in a loop: ask them.                                                                                                         |
| `user_created`                                | Nothing to do if you expected a new account. An unexpected one in `REGISTRATION_MODE=open`, or a `bootstrap` you did not make, is worth checking in the admin page.                                                                                                                                                                                                                                                                        |
| `budgetpilot.authn.register_fail`             | Nothing to do for one line. Many `bootstrap_token_invalid` lines mean someone is guessing `BOOTSTRAP_TOKEN`: make sure it is long, or empty it once the first account exists.                                                                                                                                                                                                                                                              |
| `crypt_decrypt_fail`                          | `TOTP_ENCRYPTION_KEY` is not the key this account's two-factor secret was stored with, so no code from its app can pass. If you changed the key, put the old one back and restart. Otherwise the person turns two-factor off in Settings with a recovery code and sets it up again; one with no recovery code left needs the database procedure in `docs/reference/two-factor.md`.                                                         |
| `budgetpilot.authn.reauth_fail`               | Nothing to do for one line. Repeated failures for one user pseudonym can mean someone holding that person's session is guessing their password: ask them to change their password in Settings, which logs out their other sessions.                                                                                                                                                                                                        |
| `authz_fail`                                  | Nothing to do for one line: a stale link or a page left open in a second tab writes the same. Many `not_found_or_not_owned` lines for one `budgetpilot.user.pseudonym` mean that account is trying identifiers it does not hold, and many `role_required` lines mean a member keeps reaching admin pages: ask that person, and if their session may be someone else's, reset their password from the admin page, which ends every session. |
| `authz_admin`                                 | Nothing to do if an admin meant to do it. An unexpected line means someone holding an admin's session acted: read `budgetpilot.admin.action` and the target, undo what you can, and ask that admin to change their password.                                                                                                                                                                                                               |
| `budgetpilot.redirect.refused`                | The request was not followed, so nothing reached the other host. A `bank_provider` line means the bank provider's address redirected somewhere outside `BANK_SYNC_ALLOWED_HOSTS`: check the address you configured, and whether the provider moved; a repeat with no change on your side is worth reporting to the provider.                                                                                                               |
| `budgetpilot.backfill.merges_blocked`         | Run `scripts/normalize-names.mjs --dry-run` to see which names now read as duplicates, then merge or rename them. Nothing was changed, so nothing is broken meanwhile.                                                                                                                                                                                                                                                                     |
| `budgetpilot.net_worth.links_withdrawn`       | In Settings, choose again which synchronized bank account feeds each net worth line named in the app. Until you do, those lines are not fed.                                                                                                                                                                                                                                                                                               |
| `budgetpilot.dates.check_failed`              | Nothing was changed. The check runs again at the next start; if it keeps failing, read the lines around it for the cause.                                                                                                                                                                                                                                                                                                                  |
| `budgetpilot.dates.outside_storable_range`    | Some rows have a date that can display in the wrong century, and a backup holding them is refused on restore. Nothing was changed: correct those dates.                                                                                                                                                                                                                                                                                    |
| `budgetpilot.database.overprivileged`         | Reduce the PostgreSQL account's rights as `docs/database-providers.md` describes, under « The app's database account ». The app works meanwhile.                                                                                                                                                                                                                                                                                           |
| `budgetpilot.bank.balance_fetch_failed`       | The transactions of that sync were kept; only the balance is missing. A `sync_failed` or an HTTP status from the bank is usually temporary: retry later, and reconnect the bank if it persists.                                                                                                                                                                                                                                            |
| `budgetpilot.rules.catalog_entry_skipped`     | A shipped default rule was not loaded. Nothing to do on your side: report it, with the reason and the file name from the line.                                                                                                                                                                                                                                                                                                             |
| `budgetpilot.import.write_failed`             | An import failed while writing. Read the stage, the error class and code, and the cause fields; rows written before the failure are counted in `landed_rows`. Delete the partial import and try again.                                                                                                                                                                                                                                     |
| `budgetpilot.import.account_not_remembered`   | Nothing to do: the import itself went through. The account answer will be asked again next time.                                                                                                                                                                                                                                                                                                                                           |
| `budgetpilot.transactions.counts_unavailable` | Nothing to do: the Transactions page works without the filter counts. If it repeats, read the error class and report it.                                                                                                                                                                                                                                                                                                                   |
| `budgetpilot.boot.legacy_database_adopted`    | Nothing was moved, and the instance works. To adopt the new file name, stop the container and rename the database file and its `-wal` and `-shm` siblings as the line says.                                                                                                                                                                                                                                                                |
| `budgetpilot.boot.empty_database_removed`     | Nothing to do: the removed file was empty, and the instance keeps using `/data/dev.db`.                                                                                                                                                                                                                                                                                                                                                    |
| `budgetpilot.boot.two_databases`              | Find out which file holds your history before you rely on either: [Two database files](./operations.md#two-database-files). The line repeats at every start until one of the two is renamed.                                                                                                                                                                                                                                               |
| `budgetpilot.boot.data_dir_read_only`         | The server did not start. Mount a volume at the data directory, as in the shipped Compose files, and make `DATABASE_URL` point inside it.                                                                                                                                                                                                                                                                                                  |
| `budgetpilot.boot.data_dir_not_writable`      | The server did not start. The volume belongs to a different user: change its owner to the user id in the line, as the line explains, then start again.                                                                                                                                                                                                                                                                                     |
| `budgetpilot.boot.data_dir_unusable`          | The server did not start. Check that the directory exists, has free space and is writable by the user id in the line; the error code says which of these it is.                                                                                                                                                                                                                                                                            |
| `budgetpilot.boot.migrate_failed`             | The server did not start. The database tool's own output is the lines just above this one: read them, fix the cause, and start again. Do not delete the database to get past it.                                                                                                                                                                                                                                                           |
| `budgetpilot.log.suppressed`                  | Nothing to do on its own. It says how many repeats of one event were counted instead of written in a minute. A large count of `request.failed` or `request.not_found` is worth looking at.                                                                                                                                                                                                                                                 |
| `budgetpilot.log.line_too_long`               | Nothing to do: the line was replaced by one that keeps its envelope. If it repeats for one event, report it.                                                                                                                                                                                                                                                                                                                               |
| `budgetpilot.console.output`                  | Usually nothing: a dependency printed something. Read the text; the server's « Listening on » line is expected at every start.                                                                                                                                                                                                                                                                                                             |

## Adding a log event

For a contributor. The compiler and `logInventory.spec.ts` enforce the three steps; nothing else
writes a line.

1. **Declare the names.** Add the event to `EVENT` and any new field to `ATTRIBUTE` in
   `src/lib/server/logging/names.ts`.
2. **Declare the event.** Add it to the `LogEvent` type and to `REGISTRY` in
   `src/lib/server/logging/events.ts`, with its severity, its fixed sentence, and a level for every
   attribute. An attribute without a level, or an event without an entry, does not compile.
3. **Write the documentation.** Add the event's section under « Every event », a row for each new
   field under « Every field », and, at `WARN` or above, a row under « What to do ». The spec fails
   until all three match.

Then write the line with `log()` from `$lib/server/logging`. Two settings of an event need a decision:

- **`flood: true`** when a visitor, or a member, can repeat it cheaply, so that a loop of
  requests cannot fill the disk. Its repeats are counted, as « Every event » describes.
- **`security: true`** for an authentication, authorization-failure or control-bypass event, which
  `BP_SECURITY_LOG=off` drops. The ten authentication events, `crypt_decrypt_fail`, `authz_fail` and the
  control-bypass event `budgetpilot.redirect.refused` are. The
  record of an admin action, such as `authz_admin`, is not, so no setting drops it.
- **`floodBy`** names the closed field, or the keyed hash, that splits a summarised event's window,
  so that one cheap repeat cannot hide a line of another kind.
- **`flood: false` for a failure that costs a password hash**, even without a session: the hash
  bounds the rate, and each line names its source.

Two rules hold whatever the event:

- **`console` is banned** under `src/lib/server`, `src/routes` and `src/hooks.server.ts` by a lint
  rule in `eslint.config.js`. Use `log()`.
- **Text a visitor or a remote host chose is never a field.** A value is a closed set, a number, a
  boolean, an identifier the server generated, a value checked against a pattern, or text the code
  or the operator wrote. If the only value you have is free text, log that it happened, and what
  kind, and not the text.

## Every event

This section is written by hand from `src/lib/server/logging/events.ts`, and `logInventory.spec.ts`
fails when the two disagree on any event, severity, sentence, attribute or level.

« Summarised when repeated » marks an event a visitor, or a member, can repeat cheaply. Within a minute,
the first 20 lines with the same event, status, route template and error class are written, the rest
are counted, and when the minute ends one `budgetpilot.log.suppressed` line gives the count with
that event, status, route and class. That line belongs to no request, so it carries no `trace_id`.
Five events also count separately by their own field: `excess_rate_limit_exceeded`
by `budgetpilot.ratelimit.kind`, `budgetpilot.ratelimit.counter` and `budgetpilot.user.pseudonym`,
`budgetpilot.redirect.refused` by its reason and upstream, `budgetpilot.authn.register_fail` by `budgetpilot.authn.reason`,
`budgetpilot.session.invalid` by its reason and `budgetpilot.user.pseudonym`, and `authz_fail` by its
reason, its reference and `budgetpilot.user.pseudonym`. Their summary line
carries those fields too, so a burst of one kind cannot hide a line of another.

A failed sign-in is not summarised, although anyone can cause one: at the password step each costs
the server a password hash, and at the second factor each comes after a password proven for that
sign-in and is counted by its own limit. Both bound how fast they arrive more tightly than a window
would, and each line names its source.

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

> Security event logging is off (BP_SECURITY_LOG=off): authentication, authorization-failure and control-bypass events are not written.

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

### `budgetpilot.config.env_file_exposed`

Severity WARN.

> The .env file in the working directory can be read or written by other accounts on this machine. It holds the secrets, and whoever can write it can change DATABASE_URL or ORIGIN. Run chmod 600 .env.

| Attribute                      | Level       |
| ------------------------------ | ----------- |
| `budgetpilot.config.file_mode` | Operational |

It reads only the `.env` in the working directory, not `.env.local` or a file
passed with `--env-file`. Under WSL on `/mnt/c` (drvfs mounted without the
`metadata` option), `chmod` has no effect and the line keeps the mode it found:
keep the install in the Linux filesystem.

### `budgetpilot.config.model_host_remote`

Severity WARN.

> LLM_BASE_URL names a model server that is not on this machine, so whatever a feature sends the model leaves this machine for that host. Nothing to do if you chose that host; otherwise point LLM_BASE_URL at a local server.

| Attribute                       | Level       |
| ------------------------------- | ----------- |
| `budgetpilot.config.model_host` | Operational |

Written only while `LLM_ENABLED=true` and the address is one the host
allowlist accepts. A host counts as this machine when it is `localhost`,
`127.0.0.1`, `[::1]`, `host.docker.internal`, or a name without a dot listed in
`LLM_HTTP_PERMITTED_HOSTS`, which is how the AI overlay declares its `ollama`
container. An address or a dotted name listed there is still reported.

### `budgetpilot.ai.inference_halted`

Severity WARN.

> An admin halted AI inference for the whole instance: the model call running was stopped, and every new one is refused until an admin resumes it on the admin page.

| Attribute                    | Level        |
| ---------------------------- | ------------ |
| `budgetpilot.user.pseudonym` | Pseudonymous |

Written once per halt: pressing « Halt AI » again while it is halted writes nothing, and the page
keeps showing the first admin and time. Not a security event, so `BP_SECURITY_LOG=off` keeps it.

### `budgetpilot.ai.inference_resumed`

Severity WARN.

> An admin resumed AI inference for the whole instance after entering their password again: model calls can run again.

| Attribute                    | Level        |
| ---------------------------- | ------------ |
| `budgetpilot.user.pseudonym` | Pseudonymous |

Written after the change is committed, so a resume refused for a wrong password, or rolled back
because the admin's session ended during the request, writes nothing here. The refused password is
`budgetpilot.authn.reauth_fail`.

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

### `authn_login_success`

Severity INFO.

> A sign-in succeeded and a session was created.

| Attribute                      | Level        |
| ------------------------------ | ------------ |
| `budgetpilot.client.pseudonym` | Pseudonymous |
| `budgetpilot.user.pseudonym`   | Pseudonymous |
| `budgetpilot.authn.factor`     | Operational  |

### `budgetpilot.authn.second_factor_required`

Severity INFO.

> A password was accepted and the account asks for its second factor.

| Attribute                      | Level        |
| ------------------------------ | ------------ |
| `budgetpilot.client.pseudonym` | Pseudonymous |
| `budgetpilot.user.pseudonym`   | Pseudonymous |

### `authn_login_fail`

Severity WARN.

> A sign-in failed. The step and the reason say where.

| Attribute                                 | Level        |
| ----------------------------------------- | ------------ |
| `budgetpilot.client.pseudonym`            | Pseudonymous |
| `budgetpilot.client.subnet_pseudonym`     | Pseudonymous |
| `budgetpilot.client.subnet_prefix_length` | Operational  |
| `budgetpilot.user.pseudonym`              | Pseudonymous |
| `budgetpilot.authn.step`                  | Operational  |
| `budgetpilot.authn.reason`                | Operational  |

`budgetpilot.authn.step` is `password` or `second_factor`. At the password step,
`budgetpilot.authn.reason` is `unknown_account` (no account has that email, and the line carries no
user), `wrong_password`, or `superseded` (the password was right but changed while it was checked).
At the second factor it is `wrong_code`, `reused_code`, `wrong_recovery_code`, `unrecognised_code`
(matches neither format), `unreadable_secret` (a code from the app, against a stored secret the
configured key cannot decrypt; `crypt_decrypt_fail` is written beside it) or `superseded` (the sign-in was ended by a password change or « log out
other sessions » after the code was accepted). A form with an empty field writes nothing.

### `excess_rate_limit_exceeded`

Severity WARN. Summarised when repeated.

> The rate limiter refused an attempt. The kind says which: a sign-in step, an import or a bank connection. The counter says whether the client, or the account, challenge or session it aimed at, was full.

| Attribute                                 | Level        |
| ----------------------------------------- | ------------ |
| `budgetpilot.client.pseudonym`            | Pseudonymous |
| `budgetpilot.client.subnet_pseudonym`     | Pseudonymous |
| `budgetpilot.client.subnet_prefix_length` | Operational  |
| `budgetpilot.user.pseudonym`              | Pseudonymous |
| `budgetpilot.ratelimit.kind`              | Operational  |
| `budgetpilot.ratelimit.counter`           | Operational  |

`budgetpilot.ratelimit.kind` is `LOGIN`, `MFA`, `REGISTER`, `INVITE` or `REAUTH` for a sign-in step,
and `IMPORT` or `BANK_SYNC_START` for a member's import or bank connection.
`budgetpilot.ratelimit.counter` is `address` when the client's own counter was full, `subject` when
the counter of what it aimed at was (the email for `LOGIN`, the sign-in challenge for `MFA`, the
session for `REAUTH`), or `both`. A `subject` refusal is not this client's doing: someone else's
failures against the same email refuse the owner too. The user pseudonym is present for `MFA`,
`REAUTH`, `IMPORT` and `BANK_SYNC_START`. `IMPORT` and `BANK_SYNC_START` carry no client pseudonym
and no subnet: the client address is on sign-in events only. For them `subject` is the member's own
counter, `address` the counter of their network. Repeats are summarised per member, so one member's
loop cannot hide another's refusal.

### `session_logout`

Severity INFO.

> A person signed out and their session was ended.

| Attribute                    | Level        |
| ---------------------------- | ------------ |
| `budgetpilot.user.pseudonym` | Pseudonymous |

### `user_created`

Severity WARN.

> An account was created by registration. A visitor who was not signed in is signed in to it.

| Attribute                      | Level        |
| ------------------------------ | ------------ |
| `budgetpilot.client.pseudonym` | Pseudonymous |
| `budgetpilot.user.pseudonym`   | Pseudonymous |
| `budgetpilot.authn.method`     | Operational  |

`budgetpilot.authn.method` is `bootstrap` (the first account, with
`BOOTSTRAP_TOKEN`), `backfill` (the account that adopts data from before accounts existed), `open`
(`REGISTRATION_MODE=open`) or `invitation`. An administrator creating an account from the admin page
is not on this event.

### `budgetpilot.authn.register_fail`

Severity WARN. Summarised when repeated.

> A registration was refused.

| Attribute                      | Level        |
| ------------------------------ | ------------ |
| `budgetpilot.client.pseudonym` | Pseudonymous |
| `budgetpilot.authn.reason`     | Operational  |

`budgetpilot.authn.reason` is `invitation_invalid`, `unavailable`, `email_mismatch`,
`bootstrap_token_invalid`, `email_taken` or `invitation_consumed`. A malformed email or password
writes nothing.

### `budgetpilot.authn.reauth_success`

Severity INFO.

> A signed-in person confirmed their password, and their code where asked, before a sensitive action.

| Attribute                      | Level        |
| ------------------------------ | ------------ |
| `budgetpilot.client.pseudonym` | Pseudonymous |
| `budgetpilot.user.pseudonym`   | Pseudonymous |
| `budgetpilot.authn.action`     | Operational  |

`budgetpilot.authn.action` is the action the person confirmed: `revokeSession`,
`revokeOtherSessions`, `changePassword`, `deleteAccount`, `disableTotp`, `confirmTotpSetup`,
`restoreData`, `deleteUser`, `resetPassword` or `liftInferenceHalt` (resuming AI on the admin page).

### `budgetpilot.authn.reauth_fail`

Severity WARN.

> A re-authentication before a sensitive action failed.

| Attribute                                 | Level        |
| ----------------------------------------- | ------------ |
| `budgetpilot.client.pseudonym`            | Pseudonymous |
| `budgetpilot.client.subnet_pseudonym`     | Pseudonymous |
| `budgetpilot.client.subnet_prefix_length` | Operational  |
| `budgetpilot.user.pseudonym`              | Pseudonymous |
| `budgetpilot.authn.action`                | Operational  |
| `budgetpilot.authn.reason`                | Operational  |

`budgetpilot.authn.reason` is `wrong_password`, `wrong_code`, `reused_code`, `unreadable_secret`
(a code against a stored secret the configured key cannot decrypt, with `crypt_decrypt_fail`
beside it) or `wrong_recovery_code` (turning two-factor off over such a secret, with a recovery
code that matches none unused). A refusal that checked no secret (a missing field, a second factor
not set up) writes nothing.

### `crypt_decrypt_fail`

Severity WARN.

> A code was checked against a stored two-factor secret that does not decrypt: TOTP_ENCRYPTION_KEY is not the key it was stored with. Put the old key back, or have the account turn two-factor off with a recovery code and set it up again (docs/operations.md, « The encryption key »).

| Attribute                    | Level        |
| ---------------------------- | ------------ |
| `budgetpilot.user.pseudonym` | Pseudonymous |
| `budgetpilot.crypt.purpose`  | Operational  |

Written where a code is judged, at sign-in and at re-authentication, beside the failure it caused.
A page that only shows the state, such as Settings, writes nothing. The name is the OWASP Logging
Vocabulary's, without the user it appends.

### `budgetpilot.session.invalid`

Severity INFO. Summarised when repeated.

> A request carried a session cookie that no longer works. The reason says why it stopped.

| Attribute                    | Level        |
| ---------------------------- | ------------ |
| `budgetpilot.user.pseudonym` | Pseudonymous |
| `budgetpilot.session.reason` | Operational  |

`budgetpilot.session.reason` is `unknown` (no session has this cookie: never issued, replaced
by a newer one, or its account was deleted), `revoked`, `idle` (ended by inactivity) or `expired`
(reached its lifetime). The user pseudonym is absent for `unknown`. Two limits:
`idle` and `expired` are told apart with the settings in force when the line is written
([#940](https://github.com/NonoHM/budgetpilot/issues/940)), and a copy of a cookie replaced by a
re-authentication reads as `unknown`
([#939](https://github.com/NonoHM/budgetpilot/issues/939)).

### `authz_fail`

Severity WARN. Summarised when repeated.

> An authorization was refused: a reference a signed-in person sent found nothing under their account (missing, another account's, or their own in a state the action refuses, the three merged on purpose as the answer merges them), or a member asked for an admin-only page.

| Attribute                     | Level        |
| ----------------------------- | ------------ |
| `budgetpilot.user.pseudonym`  | Pseudonymous |
| `budgetpilot.authz.reason`    | Operational  |
| `budgetpilot.authz.reference` | Operational  |

`budgetpilot.authz.reason` is `not_found_or_not_owned` when an identifier a signed-in person sent,
such as a transaction, a rule or an account, resolved to nothing under their account, and
`budgetpilot.authz.reference` names its kind. It is `role_required`, with no reference, when a
member reached a page only an admin may use. A missing row, another account's row and a row of
their own in a state the action refuses are one value on purpose: the person gets the same answer
for all three, and a log that told them apart would say more than the page does. An identifier
refused for its shape with an answer of its own writes nothing here; one answered like a missing
row writes this line. At most one line per refused reference, never one per identifier in a list. Most
actions stop at their first refusal and write one line; the column designation screen can refuse
its batch and its account in one request and writes two. No client
pseudonym and no subnet: those are on the authentication events only. An admin acting on an
account or an invitation that does not exist is not refused an authorization, and writes nothing.

Five paths write nothing although they can meet an identifier that is not the person's:

- the transactions a rule is created from in focus mode, and the transactions a recurring bill is
  anchored on: the page built both lists, the action goes on with the identifiers it kept (the bill
  is refused when none is left), and a dropped one is almost always a transaction that changed since
  the page loaded;
- the selected transaction of the transactions page (`?selected=`): it is the page's own state, and
  the page asks for the transaction it has just deleted after every delete from the panel;
- the filters of the transactions page and its export (`?ids=`, `?importBatch=`, `?tag=`): a filter
  narrows the list and refuses nothing;
- undoing a bulk tag: the tag is never looked up, and the removal reaches only the person's own
  transactions.

None of them reaches another account's data, because each reads or writes under the person's
account only. An identifier of another account met there is still not recorded, which is why
`SECURITY.md` counts `v5.0.0-16.3.2` as partly met.

### `authz_admin`

Severity WARN.

> An admin action was carried out. The action says which; the target names the account it acted on, where there is one.

| Attribute                           | Level        |
| ----------------------------------- | ------------ |
| `budgetpilot.user.pseudonym`        | Pseudonymous |
| `budgetpilot.admin.action`          | Operational  |
| `budgetpilot.target.user_pseudonym` | Pseudonymous |

`budgetpilot.admin.action` is `delete_user`, `reset_password`, `create_account` (an admin creating
an account from the registration page), `create_invitation` or `revoke_invitation`.
`budgetpilot.user.pseudonym` is the admin, and `budgetpilot.target.user_pseudonym` the account the
action acted on, present on the first three only. Written after the change is committed, so a
refused re-authentication or a missing target writes nothing here; the refused password is
`budgetpilot.authn.reauth_fail`. Not a security event, so `BP_SECURITY_LOG=off` keeps it.

### `budgetpilot.redirect.refused`

Severity WARN. Summarised when repeated.

> An outbound request was answered with a redirect the guard refused to follow. The reason says why; the upstream says which service sent it.

| Attribute                       | Level       |
| ------------------------------- | ----------- |
| `budgetpilot.redirect.reason`   | Operational |
| `budgetpilot.redirect.upstream` | Operational |

`budgetpilot.redirect.reason` is `target_not_allowed` when the redirect pointed at a host the
allowlist refuses, `unresolvable_location` when its address could not be read, and
`too_many_redirects` when the chain went past five hops. `budgetpilot.redirect.upstream` is
`bank_provider` or `model_host`; no page reaches the model host in this release, so only
`bank_provider` lines can appear. The line carries neither the host nor the address the redirect
named, since the remote chose both, and no client or user: the party a refused redirect implicates
is the service that sent it.

A cross-site form refusal writes nothing. SvelteKit answers a POST from another origin with 403
before the application sees the request, so there is no line to write; the refusal itself still
happens.

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

### `budgetpilot.boot.empty_database_removed`

Severity WARN.

> Removed an empty /data/budgetpilot.db beside /data/dev.db. It held no data: a command run in the container while this install used the old name had created it. Your data is in /data/dev.db.

No attributes beyond the envelope.

### `budgetpilot.boot.two_databases`

Severity WARN.

> Both /data/budgetpilot.db and /data/dev.db hold a database. Using /data/budgetpilot.db. If your history is in /data/dev.db, see « Two database files » in the operations guide; this line repeats at every start until one of the two is renamed.

| Attribute                                | Level       |
| ---------------------------------------- | ----------- |
| `budgetpilot.boot.database_bytes`        | Operational |
| `budgetpilot.boot.legacy_database_bytes` | Operational |

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

| Attribute                               | Level        |
| --------------------------------------- | ------------ |
| `budgetpilot.log.suppressed_event`      | Operational  |
| `budgetpilot.log.suppressed_count`      | Operational  |
| `budgetpilot.log.window_seconds`        | Operational  |
| `budgetpilot.log.suppressed_status`     | Operational  |
| `budgetpilot.log.suppressed_route`      | Operational  |
| `budgetpilot.log.suppressed_error_type` | Operational  |
| `budgetpilot.ratelimit.kind`            | Operational  |
| `budgetpilot.ratelimit.counter`         | Operational  |
| `budgetpilot.authn.reason`              | Operational  |
| `budgetpilot.session.reason`            | Operational  |
| `budgetpilot.authz.reason`              | Operational  |
| `budgetpilot.authz.reference`           | Operational  |
| `budgetpilot.user.pseudonym`            | Pseudonymous |
| `budgetpilot.redirect.reason`           | Operational  |
| `budgetpilot.redirect.upstream`         | Operational  |

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

| Attribute                    | Level          |
| ---------------------------- | -------------- |
| `budgetpilot.console.method` | Operational    |
| `budgetpilot.console.text`   | Not classified |

---

If you use an instance someone else runs, [what the security log records about you](./using/security-logging.md)
is the page written for you.
