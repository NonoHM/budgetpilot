# Why the log looks like this

**Audience:** whoever runs the instance, and whoever reviews its security. **Type:** explanation.

[Logs](../logging.md) says what a line contains. This page says why it is built that way. Each
section starts from a choice that surprises someone who expects an ordinary application log, and
gives the reason. The security requirements cited are from
[OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) (the
application security verification standard the project is assessed against), quoted from the text
tracked in [`docs/reference/standards/`](../reference/standards/README.md). Where a choice contributes to a requirement without meeting
it, the section says what is missing.

## One JSON object per line

The log is one JSON object per line, each with the same envelope and flat values, rather than
sentences a person writes and a program later tries to read.

Two reasons. A program can read it without guessing: a field has one name, one meaning and one type
on every line, so a filter that says `severity_number >= 17` cannot be fooled by wording. And a
line has one place to end. In a free-text log, a value that contains a line break can start what
looks like a new entry, and so forge one. JSON escapes line breaks inside a string, so a value
cannot end its own line.

JSON is not enough on its own, so the writer goes one step further. Two Unicode characters
(U+2028 and U+2029) and the delete and control characters are left untouched by common JSON
encoders, and a viewer that honours them draws a new line or repaints a terminal. The writer
replaces each of them with its `\uXXXX` escape, which stays valid JSON and decodes to the same
value. This is what ASVS v5.0.0-16.4.1
asks of a logging component (Level 2): « Verify that all logging components appropriately encode
data to prevent log injection. » The writer contributes to it for what the application writes. It
does not reach what it does not write: an error that Node prints while modules are still loading
(on its own error stream), or the output of the database tool that runs at start
([#846](https://github.com/NonoHM/budgetpilot/issues/846)).

Values are flat and small: strings, numbers and booleans, a string cut at 256 characters, and a
whole line cut at 8192 bytes so that Docker, which splits a line at 16 KiB, never turns one event
into two records.

## OpenTelemetry names, and no OpenTelemetry SDK

The field names follow the [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/),
and the application does not use the OpenTelemetry SDK, an exporter or any network transport.

The names are there so that the operator's collector can convert the log with no mapping work of
its own: `severity_number` is OpenTelemetry's scale, `trace_id` is its trace identifier, and the
rest are attributes. [Send the log to a collector](../logging-collectors.md) shows it done, and
shows the further mapping to ECS and OCSF for platforms that use those.

The SDK is left out for a reason of privacy, not of convenience. An exporter is a program that sends
data to a host, and the project's rule is that no external host is called without an explicit
allowlist. A log that the application pushes somewhere is a log that could be configured to leave
the machine by a setting nobody reviewed. Writing to standard output moves that decision to the one
place that already controls the container: the operator, who chooses the collector and its
destination. The application also stays free of a vendor: switching platform changes the collector's
configuration, not the application.

## A typed catalogue, and two levels

Every event is a member of one closed list, `src/lib/server/logging/events.ts`, with a fixed
sentence and a fixed set of fields, and every field carries a protection level from
[the data classification](./data-classification.md). The type admits only the two levels a log may
hold, Operational and Pseudonymous, so a field that is Secret, Financial or Personal cannot be
declared: the program does not compile. A lint rule refuses a plain `console` call in the server
code, so there is no second way to write a line.

The choice replaces a rule that people have to remember (« do not log the amount ») with one the
compiler checks. A rule that depends on every author on every day fails on one of them. The cost is
that adding an event means adding a line to the catalogue and a row to [Logs](../logging.md), which
`logInventory.spec.ts` checks. That friction is the point: nobody adds a field to the log without
the question of its level being asked.

## The route template, not the path

A line carries `http.route`, the matched template such as `/imports/[batchId]`, and never the
address that was requested. The address is the one part of a request that a visitor types freely, so
it can hold anything: an account number pasted into a URL, a search, a payload. A template comes
from the application's own list of pages and contains nothing a visitor chose. It also has a small
number of values, which is what a collector wants of a field it groups by. A request that matches no
page has no template, so the 404 line says that a page was not found and not which.

## An identifier the server makes

The `trace_id` of a request is generated by the server, and a header such as `X-Request-Id` that a
client or a proxy sends is never read. A proxy forwards whatever it was sent, so an identifier taken
from a header is an identifier chosen by whoever sent the request, and any pattern broad enough to
accept the identifiers people use is broad enough to accept a bank account number. Generating it
removes the question. The value is the one the error page shows the visitor (with dashes) as a
reference, so that a person can quote it and an operator can find the line behind it.

## Client addresses as a keyed hash

No event in this version carries a client address. The design for the events that will
([#250](https://github.com/NonoHM/budgetpilot/issues/250)) is that an address is logged only as an
HMAC (a keyed hash), never in clear and never truncated, and only on authentication events and on the
rate limiter's refusal of an authentication attempt. These are rulings R1 and R9 on
[#841](https://github.com/NonoHM/budgetpilot/issues/841#issuecomment-5931570298).

An address is personal data, and an operator who needs to see that one source failed many times needs
to tell addresses apart, not to read them. A keyed hash does that: the same address always gives the
same value, and the value cannot be turned back into an address by someone who does not hold the
key. The key is derived from `RATE_LIMIT_HASH_SECRET` under its own label, so a logged value never
equals the hash the rate limiter stores in the database, and a log line cannot be joined to that
table.

The protection has a limit that the design does not hide. There are only about four billion IPv4
addresses, so whoever holds `.env`, and therefore the key, can recover any logged address by trying
them all. The hash protects the address from every other reader of the log: a collector, a
monitoring tool, a copy that leaks. It does not protect it from the operator, who could read the
network logs anyway. Rotating the secret changes every hash, which ends the matching of addresses
across the rotation. The key has no setting of its own, so rotating the rate limiter's secret rotates
it too.

## What the hash chain proves, and what it does not

Each line carries its number and the SHA-256 of the previous line, per start of the server. Someone
who removes or edits a line in a copy of the log breaks the chain at the next line, and a script
finds the break ([how to check it](../logging-howto.md#check-that-no-line-was-removed-or-edited)).

The chain has no key, because there is no place to keep one that the host does not control. That
sets what it can prove. It cannot stop anyone who controls the host from rewriting the whole file and
every hash with it, and it cannot show that the last line of a capture, or the lines after the end
of one, are unchanged. It detects a change made to a copy of the log, by someone who did not
recompute the chain. What makes it more than that is a copy held somewhere the host cannot reach, so
that the person who can edit one file cannot edit the other. The how-to shows the check passing, and
failing on a removed line and on an edited one, and records the last line as a case it misses.

## Why repeats are summarised

Some events can be caused by a visitor who has not signed in: a page that does not exist, an
unexpected error. Written one line per request, a loop of requests becomes a loop of disk writes, and
the log becomes the way to fill the disk. For these events the first 20 lines of one event within a
minute are written. The rest are counted, and when the minute ends one `budgetpilot.log.suppressed`
line gives the count.

The trade-off is detail. During a burst, the lines past the twentieth are gone, so the log shows how
many requests failed and not which. The count survives, and so does the first twenty. The other
choice, keeping every line, trades a lost line for a full disk and a lost log. The key that groups
lines is the event name, plus the status code where there is one, both from closed sets, so what the
counter holds in memory is bounded by the catalogue and not by what visitors send.

## What is never logged

The log never records an error's message or its stack, the address that was requested, or any text a
visitor or a remote host chose. This is the rule behind #816.

The reason is measured, not assumed. A database error quotes the row it refused, and a row is a
user's transaction: a label planted in a failing write reached the log through the default error
printers, in the message and in a nested property. Personal data has no pattern to remove, so a
filter that scrubs messages fails on the first value nobody anticipated. The design instead allows
what is known to be safe. An error contributes its class name and its code, each checked against a
pattern, because those are what an operator looks up. The only message that passes is one the
application wrote for the operator, marked as such, such as the refusal of a setting outside its
allowed values.

The cost falls on the operator, who gets less than a stack trace. The reference closes most of that
gap. The visitor is shown the same generic message for every failure, in line with
ASVS v5.0.0-16.5.1
(Level 2): « Verify that a generic message is returned to the consumer when an unexpected or
security-sensitive error occurs, ensuring no exposure of sensitive internal system data such as stack
traces, queries, secret keys, and tokens. » The reference they are shown is the line's error id, so
a person can say which failure they met and the operator can read what kind it was, without the page
or the log holding the data.

## What the application does not do about the log

The application writes lines and stops there. It does not decide who can read them, and it does not
copy them anywhere. Two requirements of ASVS 5.0.0 describe exactly those two things, and the
application contributes to them and leaves the rest to the operator.

- **ASVS v5.0.0-16.4.2**
  (Level 2): « Verify that logs are protected from unauthorized access and cannot be modified. »
  The application cannot do this from inside the process. The log is in Docker's files, read by root
  and the `docker` group, and an access control there is the host's. What the application adds is
  tamper evidence on a copy (the chain) and a size bound on the log Docker keeps.
- **ASVS v5.0.0-16.4.3**
  (Level 2): « Verify that logs are securely transmitted to a logically separate system for analysis,
  detection, alerting, and escalation. The aim is to ensure that if the application is breached, the
  logs are not compromised. » The application sends nothing, by design (see above), so the
  transmission is the operator's collector, on the operator's TLS and credentials. What the
  application adds is a log that a collector can read without conversion, and
  [recipes](../logging-collectors.md) for four of them.

`SECURITY.md` has no row for either requirement yet; adding them is part of
[#250](https://github.com/NonoHM/budgetpilot/issues/250). The application alone satisfies neither. Whether an instance meets them depends on what
its operator sets up around it: access to the host's log files, and a second system with its own
protection. An instance with no collector has nothing separate to receive the log. That is a
deliberate boundary and not a missing feature: a program that sent its own logs would need a
destination and credentials, which is the dependency the project avoids.

## Where to go next

- [Logs](../logging.md) lists every event and every field.
- [Your first look at the logs](../logging-tutorial.md) walks through reading them.
- [How BudgetPilot classifies the data it stores](./data-classification.md) defines the levels.

---

If you use an instance someone else runs, [what the security log records about you](../using/security-logging.md)
is the page written for you.
