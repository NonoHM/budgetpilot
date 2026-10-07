# Configuration

For operators. Everything is configured through `.env`, sitting next to your
compose file. [Configuration reference](configuration-reference.md) lists every
variable with its default and the values it accepts; it is generated from the
code, so it cannot fall out of date. This page is the prose version: what you'd
actually want to change, and why.

After editing `.env`, restart the app for it to take effect:

```bash
docker compose up -d          # or: docker compose -f docker-compose.prebuilt.yml up -d
```

## The three secrets

Required. The app refuses to start without `RATE_LIMIT_HASH_SECRET` or
`TOTP_ENCRYPTION_KEY`, and without `BOOTSTRAP_TOKEN` until you've created
your first account.

| Variable                 | What it does                                                                                                                                                                  | If it's missing                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_TOKEN`        | Gates account creation while registration is closed                                                                                                                           | Crash at startup with `BOOTSTRAP_TOKEN is required to create the first account`, but only while the instance still has no admin account. Once you have one, a blank value is a warning: registration then only works through an invitation link. Not used at all in `open` mode |
| `RATE_LIMIT_HASH_SECRET` | HMAC key for the emails and IPs stored by login rate limiting, so they're never in clear text. A second key derived from it hashes the account numbers of remembered accounts | Crash at startup with `RATE_LIMIT_HASH_SECRET is required`                                                                                                                                                                                                                      |
| `TOTP_ENCRYPTION_KEY`    | AES-256-GCM key encrypting two-factor secrets at rest                                                                                                                         | Crash at startup with `TOTP_ENCRYPTION_KEY is required`                                                                                                                                                                                                                         |

`TOTP_ENCRYPTION_KEY` is the one to never lose or rotate casually: change it
and every account with two-factor enabled is locked out of its second
factor. Rotating `RATE_LIMIT_HASH_SECRET` resets rate-limit counters and
makes every remembered account stop matching: nothing is lost or misfiled,
the next statement of each account asks again which account it goes to,
and the answer is remembered anew. The old entries stay listed under
Settings > Remembered accounts until you forget them. It also changes the
key that hashes client addresses in the log, so addresses logged before and
after the rotation can no longer be matched ([logs](./logging.md#the-client-address)).

`npm run setup` regenerates all three, so don't rerun it on an instance you
already use. Edit `.env` directly to flip a single setting.

Keep `.env` readable by your account only: `chmod 600 .env`. `npm run setup`
and the `.env` block in the README already do. When the `.env` in the directory the app starts from can be read
or written by other accounts on the machine, the app logs a
`budgetpilot.config.env_file_exposed` warning at startup with the mode it
found ([logs](./logging.md#what-to-do)). It reads that one file only, not
`.env.local` or a file passed with `--env-file`. Under Docker it cannot check:
Compose reads `.env` on the host and the container never sees the file. Under
WSL on `/mnt/c` (drvfs mounted without the `metadata` option), `chmod` has no
effect and the warning keeps the mode it found, so keep the install in the Linux
filesystem. Under Git Bash, Node runs as a Windows program and the check is
skipped.

## Refusing to start on an exposed secret file

`.env` holds the three secrets above, and sometimes a database password. Every
start already writes a `budgetpilot.config.env_file_exposed` warning when other
accounts on the machine can read or write it. To refuse to start instead, set:

```dotenv
BP_STRICT_SECRET_FILES=on   # default: off, which only warns
```

With it on, the app checks `.env` in the directory it starts from and the
file named by `ENABLE_BANKING_PRIVATE_KEY_PATH`, and refuses to start when:

- another account can change the file;
- the file belongs to the account the app runs as, and other accounts can read it;
- the file belongs to an account other than that one or root;
- the folder holding it can be written by other accounts, or belongs to
  another account, since either lets that account replace the file;
- the file exists but cannot be inspected.

The message names each file, what is wrong, and the fix. On a host install,
run these as the account that starts the app:

```bash
chmod 600 .env
chmod 700 .     # or any mode where only you can write to the folder
```

**Under Docker**, the container never has a `.env` (Compose reads it on the
host), so only the bank-signing key is checked, and the app runs as user 65532. Either give the file and its folder to that user, or to root with the
file readable by all, which is how a Compose secret is mounted:

```bash
sudo chown 65532 keys keys/enablebanking.pem && sudo chmod 600 keys/enablebanking.pem
# or
sudo chown root:root keys keys/enablebanking.pem && sudo chmod 444 keys/enablebanking.pem
```

The rules are those of OpenSSH's `StrictModes`, which checks a user's key
files the same way: write access for others is refused whoever owns the file,
and read access only when the file belongs to the account itself. A file owned
by root and readable by all is accepted because that is how Docker Compose and
systemd hand a secret to a process that does not run as root. This switch
contributes to ASVS `v5.0.0-13.3.2`, « Verify that access to secret assets
adheres to the principle of least privilege », without meeting it on its own:
it is off by default, and a secret passed as an environment variable has no
file to check.

## Exposing it beyond localhost

This is where most people get stuck, so read it before you try.

### `ORIGIN` has to be exact

`ORIGIN` must be the exact URL you type in the browser, protocol and port
included, no trailing slash. SvelteKit checks it against the `Origin` header
of every form submission as CSRF protection. If it doesn't match, login,
registration and every other form fail with `403 Cross-site POST form
submissions are forbidden`, while the pages themselves load fine.

Different port on the same machine: change `APP_PORT` and stop there.

```dotenv
APP_PORT=3001
```

The compose file computes `ORIGIN: ${ORIGIN:-http://localhost:${APP_PORT:-3000}}`,
so an unset `ORIGIN` follows the port you published and the two cannot drift
apart. This is why `.env.example` ships that line commented out.

Writing `ORIGIN` by hand opts you out of that. Your line wins over the default,
and the two must then move together, which is the mismatch this section exists
to explain. Set it only when localhost is not what you type: a LAN
address, a hostname, or anything behind a reverse proxy.

`APP_PORT` is the host-side port Docker publishes. The container always
listens on 3000 internally, that never changes.

### `PUBLIC_INSTANCE` and the session cookie

`PUBLIC_INSTANCE` is the single switch governing the `Secure` flag on the
session cookie, and it is fail-secure: unset, empty, `true` or a typo all
mean `Secure`. Only the literal value `false` turns it off. `NODE_ENV` plays
no part in the decision.

That matters because browsers only accept a `Secure` cookie over HTTPS, plus
the two plain-HTTP origins they consider trustworthy anyway: `localhost` and
`127.0.0.1`. They refuse it over `http://192.168.1.42:3000` or
`http://budget.lan`. On those, login appears to work and then bounces you
straight back to the login page, forever, because the cookie was never
stored.

So pick the line that matches how you reach the app:

**HTTPS behind a reverse proxy**, the right answer for anything beyond your
own machine:

```dotenv
ORIGIN=https://budget.example.com
PUBLIC_INSTANCE=true
```

The proxy terminates TLS and forwards to the container over plain HTTP.
There's a ready-made Caddy overlay in
[reverse proxy](./reverse-proxy.md), which gets you automatic
certificates in about three commands.

**Plain HTTP on your LAN**, at an address that isn't localhost:

```dotenv
ORIGIN=http://192.168.1.42:3000
PUBLIC_INSTANCE=false
```

This is the one case where dropping the flag is correct, and the only way to
make LAN access work at all. Session cookies then travel in clear text on
your network, so keep it to a network you trust and never to an
internet-reachable instance. The app logs a warning at startup while this is
active, on purpose.

**Localhost only**, the default: change nothing. `ORIGIN` stays
`http://localhost:3000` and `PUBLIC_INSTANCE` stays `true`, since browsers
accept the `Secure` cookie there regardless.

**Or a tunnel**, so the browser still talks to localhost. A Tailscale
tailnet with its HTTPS certificates, or plain SSH port forwarding:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

Then browse `http://localhost:3000` on your laptop, with `ORIGIN` left at
`http://localhost:3000` and `PUBLIC_INSTANCE` left alone.

Exposing this to the open internet is your call to make, but the honest
answer is that a self-hosted finance app belongs on your LAN or behind a
VPN. If you do expose it, use HTTPS, leave `PUBLIC_INSTANCE` at `true`, and
leave registration closed.

## Who can create an account

```dotenv
REGISTRATION_MODE=admin_only   # default
```

- `admin_only`: `/register` requires the `BOOTSTRAP_TOKEN`. The first
  account created becomes an admin. After that, an already-logged-in admin
  can create more accounts, or generate single-use invitation links from the
  admin panel.
- `open`: anyone who can reach `/register` can create an account, protected
  only by IP rate limiting. No CAPTCHA, no email verification. Fine for a
  machine only you can reach, a bad idea on a public URL.

Any unrecognized value falls back to `admin_only`.

## Passwords and sessions

```dotenv
PASSWORD_HASH_COST=12    # bcrypt cost: 12 to 15
SESSION_TTL_DAYS=30      # how long a sign-in lasts: 1 to 400 days
INVITATION_TTL_HOURS=72  # how long an invitation link stays valid: 1 to 720 hours
```

A value outside its range stops the app at startup with a message naming the
setting, the range and the default. It is never adjusted to the nearest
allowed value, so the setting in force is always the one you wrote.

**`PASSWORD_HASH_COST`** sets how much work storing and checking a password
takes. Each step doubles it: one hash took 160 ms at 12 and 1.3 s at 15 on a
desktop processor (measured 2026-10-07). 12 is above the minimum of 10 that the
OWASP Password Storage Cheat Sheet and ASVS 5.0.0 Appendix C give for bcrypt.
The ceiling is 15 because every sign-in pays the cost, so a higher value lets
anyone who can reach the sign-in form keep the server busy. A raised cost
applies to passwords set or changed afterwards; existing passwords keep the
cost they were stored with.

**`SESSION_TTL_DAYS`** is the absolute lifetime of a sign-in: when it ends, the
user signs in again, however active they were. The ceiling is 400 days because
Chrome, Firefox and Safari keep a cookie for at most 400 days whatever the
server asks (the limit in the IETF cookie specification draft,
`draft-ietf-httpbis-rfc6265bis-22`, section 5.5). A longer lifetime would only
keep a copied cookie usable.

**How 30 days compares with NIST SP 800-63B-4.** ASVS
`v5.0.0-7.1.1` asks that the session lifetime be documented, with « justification
for any deviations from NIST SP 800-63B re-authentication requirements ». NIST
asks that a sign-in last « no more than 30 days » for a password alone, and « no
more than 24 hours », with an inactivity timeout of « no more than 1 hour »,
once a second factor is in use. The default meets the first. With two-factor
authentication turned on it does not meet the second: the default favours
staying signed in on a personal device, and there is no inactivity timeout yet
([#221](https://github.com/NonoHM/budgetpilot/issues/221)). If your instance is
reachable from the internet and your users have two-factor authentication, set
`SESSION_TTL_DAYS=1`.

**`INVITATION_TTL_HOURS`** bounds how long an invitation link works. Anyone
holding the link can create an account with it, so it stays short. The ceiling,
720 hours (30 days), is the longest validity NIST SP 800-63B-4 gives any
one-time code, for one sent by post.

Two-factor authentication (TOTP) is per user and opt-in, enabled from
Settings. No admin action exists to disable someone else's second factor,
deliberately, so keep your recovery codes.

## Database

BudgetPilot runs on SQLite, PostgreSQL, or MySQL/MariaDB. Two variables
configure all three, and there is nothing else to set.

```dotenv
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:./dev.db"
```

`DATABASE_PROVIDER` accepts `sqlite`, `postgresql` (or `postgres`), and
`mysql` (or `mariadb`). Leave it unset and you get SQLite, which is the
recommended setup: it needs no server, and the whole database is one file you
can copy. Under Docker, both variables come from your `.env`. Set neither and
the compose files default `DATABASE_URL` to `file:/data/budgetpilot.db`, which lives
in the `budgetpilot_data` volume.

An unrecognized value stops the app at startup rather than falling back to
SQLite. Falling back would start you against an empty local file while your
real database sat untouched, and every screen would report no data.

To use PostgreSQL:

```dotenv
DATABASE_PROVIDER=postgresql
DATABASE_URL="postgresql://budgetpilot:yourpassword@db:5432/budgetpilot"
```

To use MySQL or MariaDB:

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://budgetpilot:yourpassword@db:3306/budgetpilot"
```

`mysql://` is the canonical form and the one to write, for MariaDB as much
as for MySQL: they are one engine as far as the app is concerned. A
`mariadb://` URL is accepted too and normalized internally, so an operator
who sets `DATABASE_PROVIDER=mariadb` and writes the matching scheme gets a
working stack rather than a startup error naming neither variable. The two
schemes are equivalent; the examples here are the documented form.

The scheme and the provider have to agree. `postgresql://` (or `postgres://`)
goes with `postgresql`, `mysql://` (or `mariadb://`) with `mysql`. A mismatch
stops the app at startup, because the alternative is connecting to a database
you didn't mean and finding out later.

Create the database and its user yourself before first boot. BudgetPilot
applies its own schema on every start, but it never creates the database.

Don't want to run a server yourself? There are two optional Compose overlays
that start one for you, alongside the app and unpublished to the host:
[using PostgreSQL or MySQL](./database-providers.md). Adding the overlay sets
both variables for you, so you leave them out of `.env` entirely. Its
`DATABASE_PASSWORD` is the only value you supply.

Two things to know before you pick a server engine:

- Migrating an existing SQLite install to PostgreSQL or MySQL is not
  automatic. Export your data from Settings first, start the new instance
  empty, then import the file.
- Account emails must be ASCII. MySQL and MariaDB compare emails without
  regard to accents, so "café@example.com" and "cafe@example.com" would be
  the same account there and two different ones on SQLite and PostgreSQL.
  Requiring ASCII keeps one answer on every engine. This applies when an
  account is created or invited; an account registered with a non-ASCII
  address before this rule can still sign in.

### Which engine to choose

Pick SQLite unless you have a reason not to. It is the default, it is what
most installs run, and for a household-sized budget it is faster than a
network round trip to a server.

Choose PostgreSQL or MySQL when you already run one, when you keep your
database on separate storage from your application, or when your backup
tooling is built around a database server. [Using PostgreSQL or
MySQL](./database-providers.md) walks through both, including what switching
an existing install actually costs.

## Writing a limit

Every setting that takes a whole number (the
[reference](configuration-reference.md) gives each one's range) is written
with the digits 0 to 9 and nothing else, and must sit inside its range.

Any other spelling stops the app at startup, with a message naming the
variable: `0x10`, `1e2`, `12.0`, `+5` and `1_000` are all refused rather than
read as a number you did not write. Spaces around the number are ignored, and
an empty value is the same as leaving the variable out.

## How many columns a statement may have

`CSV_MAX_COLUMNS` is **optional**: leave it out and you get 512. It bounds how
many columns an imported statement may declare, checked before anything else
reads the file.

**It is not there because a wide file is slow to read.** It is not. Measured
against the widest shapes the 256 KB limit allows: 100 columns over 1000 rows
parses in 37 milliseconds, and 27,000 columns in a single row parses in 28. The
size limit already bounds the work.

It is there for the screen that lets you say which column holds your dates,
your labels and your amounts. That screen draws one card per column and shows
three real values inside each, so its cost is per column rather than per byte.
27,000 columns in one row fits comfortably inside the size limit and would ask
that screen for 27,000 cards and 81,000 values.

512 is about thirteen times the widest thing anyone actually exports: a bank
statement carries around fifteen columns, an accounting package around forty.
Set it lower than 40 and the startup log says so, because at that point you are
refusing files this app should be able to read.

A value above 4096 is refused at startup rather than quietly reduced, for the
same reason as the two limits below: **a limit you set should be the limit that
runs.**

## How many column mappings one account may keep

`COLUMN_MAPPINGS_PER_USER` is **optional**: leave it out and you get 50.

When you tell BudgetPilot which column of a statement holds your dates, your
labels and your amounts, it remembers that answer so the next statement with the
same columns imports without asking. One answer is kept per distinct set of
column names.

50 is generous on purpose. Five banks with three format changes each is fifteen.

**Nothing forgets a remembered answer on its own.** You remove one in
**Settings > Remembered columns** (see
[Forget a remembered answer](./using/imports.md#forget-a-remembered-answer)). Restoring a backup
replaces your answers with the backup's, and deleting your account removes them
with it. Nothing else does, so this limit is what bounds a table that every new
set of column names grows.

Reaching it is refused rather than solved by quietly forgetting your oldest
answer: forgetting one would mean your regular bank stops being recognised
because you once imported twenty odd files, which is a worse surprise than being
told the limit was reached.

If you do reach it, the statement still imports. The import page says its
columns were not remembered and links to Settings, where you can remove an
answer you no longer need.

## How many uploads one account may make

`IMPORT_RATE_LIMIT_MAX_ATTEMPTS` is **optional**: leave it out and you get 60.
It bounds how many uploads the import pages accept per account, and per
address, in 15 minutes. Past that, the import page says there were too many
attempts and to try again in a few minutes.

60 clears any batch a person uploads by hand. A household importing a year of
monthly statements across three accounts sends about three dozen files in one
sitting. Set it lower than 36 and the startup log says so, because at that
point you are refusing an ordinary sitting.

**240 is a hard ceiling and a higher value stops the app at startup** rather
than being quietly reduced. Retrying an import gains an attacker nothing
secret: every import page needs a session, and a refusal says nothing about
anyone else's data. What a retry buys is server time. With
[the spreadsheet limit](#upload-size) at its own ceiling, opening one
spreadsheet holds the server for about a second, and nothing else is answered
meanwhile. At 240 uploads per 15 minutes, one account can then hold the server
for about a quarter of that time. Much higher, and one account could hold it
for the whole window.

Any value other than 60 is named in the startup log, alongside the default.

## Backup size

`BACKUP_MAX_JSON_NODES` is **optional**: leave it out and you get 2,000,000,
which is the measured default. It bounds how many separate entries a backup
file may contain, checked before the file is opened.

It exists because the size of a backup does not tell you what it costs to
open. A 20 MB file holding a real history of 40,559 transactions takes about
132 MB of memory and a tenth of a second. A 20 MB file crafted to hold as
many empty entries as possible takes **801 MB**, and the check that would
reject it as not-a-backup only runs after that memory has been spent. So the
app counts the entries first, which takes 28 ms, and refuses before opening.

2,000,000 is a little over twice the most this app can itself put in a
backup, which is 888,888 entries at the 20 MB limit. That headroom is the
point: **the app must always be able to restore a file it produced.** Set it
lower and you risk your own backups being refused, with a message saying the
file is too complex rather than that a limit was lowered. The startup log
says so too if you set it below that figure.

**4,000,000 is a hard ceiling and a higher value stops the app at startup**
rather than being quietly reduced. At 4,000,000 the worst case is about
214 MB to open one backup, against 107 MB at the default. Refused rather
than clamped for the same reason as the spreadsheet limit above: a limit
that silently reduces your value leaves your restore failing for a reason
your own configuration says should not apply.

One thing it does not cover, said plainly rather than left to be discovered:
a backup that is one enormous piece of text rather than many entries has one
entry, so this limit is silent about it. That case is cheap (20 MB of text
costs 20 MB) and `BODY_SIZE_LIMIT` is what bounds it. The two work together:
one bounds size, the other bounds structure.

## Logging

The server writes one JSON object per line to standard output. [Logs](./logging.md)
lists every event and field, where the log goes and how long it is kept.

| Variable          | Values                  | Default | If you change it                                                                                                                                                                                                |
| ----------------- | ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BP_LOG_LEVEL`    | `debug`, `info`, `warn` | `info`  | Lines below that severity are not written. There is no level above `warn`, and `sys_startup`, `sys_monitor_disabled`, `sys_crash` and every `budgetpilot.config.*` event are `WARN`, so they are always written |
| `BP_SECURITY_LOG` | `on`, `off`             | `on`    | `off` drops the security events, and every start writes a `sys_monitor_disabled` line saying so. This version has no security event yet ([#250](https://github.com/NonoHM/budgetpilot/issues/250))              |

Any other value stops the server at start, naming the allowed values. A value
other than the default is written in the startup log.

## Optional features

Both are off by default, and neither makes a single network call while off.

```dotenv
LLM_ENABLED=false         # local AI advice, see docs/ai-insights.md
BANK_SYNC_ENABLED=false   # automatic bank sync, see docs/bank-sync.md
```

## Upload size

**If a statement was refused as too large, split it by date range and import
the parts.** That is safe: duplicate detection works per transaction rather
than per file, so the overlap between two pieces is imported once. It holds as
long as every piece is read through the same columns, which splitting a file by
date range does not change. See
[duplicate detection](./reference/imports.md#duplicate-detection).

The rest of this section is why that works, and what to change if it is a
backup rather than a statement that was refused.

```dotenv
BODY_SIZE_LIMIT=21000000
IMPORT_XLSX_MAX_UNCOMPRESSED_MB=8   # optional, 32 maximum
BACKUP_MAX_JSON_NODES=2000000       # optional, 4000000 maximum
CSV_MAX_COLUMNS=512                 # optional, 4096 maximum
COLUMN_MAPPINGS_PER_USER=50         # optional, 500 maximum
```

| What you are uploading    | What limits it                                              | Can you change it |
| ------------------------- | ----------------------------------------------------------- | ----------------- |
| A bank statement, `.csv`  | 256 KB, and a limit on how many columns it declares         | the second one    |
| A bank statement, `.xlsx` | 256 KB as sent, and a second limit on the sheet once opened | the second one    |
| A backup, to restore      | 20 MB, and a second limit on how many entries it holds      | the second one    |

The `.xlsx` row has two limits because a spreadsheet file is a compressed
archive: a small file can hold a very large sheet, so the app also checks how
big the sheet is once opened. That second one is
`IMPORT_XLSX_MAX_UNCOMPRESSED_MB` below.

The 256 KB statement limit is not configurable today.

The backup row has two limits for a related reason: a 20 MB file can hold a
few thousand entries or several million, and it is the number of entries
rather than the size that decides how much memory opening it takes. That
second one is `BACKUP_MAX_JSON_NODES` below.

`BODY_SIZE_LIMIT` is not in the table because it is not about any one of
these: it caps every HTTP request, and it exists so the largest of the above
fits through. **Lowering it below 20 MB breaks restoring a large backup**,
which is the one refusal that costs you your data recovery rather than an
import you can retry. Raising it does not raise any of the limits in the
table.

`IMPORT_XLSX_MAX_UNCOMPRESSED_MB` is **optional**: leave it out entirely and
you get 8, which is the measured default. It is not one of
[the three secrets](#the-three-secrets), and unlike those, its absence never
stops the app. It is the second of the two limits on an `.xlsx`: the one on
the sheet once opened, rather than on the file as sent.

8 MB is roughly two and a half times the largest workbook a spreadsheet
application produced that still fits under the 256 KB upload limit. If a
genuine export is ever refused, raise it, and please
[open an issue](https://github.com/NonoHM/budgetpilot/issues): the number
came from a measurement and a better measurement should replace it.

**32 is a hard ceiling and a higher value stops the app at startup** rather
than being quietly reduced to 32.

Where 32 comes from, since a ceiling nobody can justify is a number someone
will eventually raise. Opening a workbook holds the server's only thread for
as long as it takes, so the limit is set by how long you are willing for one
upload to make the app unresponsive. Measured on the shape that costs most,
tens of thousands of small XML elements rather than one large one:

| Unpacks to          | Memory to open it | Time to open it |
| ------------------- | ----------------- | --------------- |
| 3.2 MB (a real one) | ~100 MB           | 153 ms          |
| **8 MB** (default)  | 192 MB            | **340 ms**      |
| 16 MB               | 310 MB            |                 |
| **32 MB** (ceiling) | 467 MB            | **1054 ms**     |
| 48 MB               | 672 MB            |                 |
| 64 MB               | 845 MB            |                 |

32 is the largest of those whose parse still takes about a second. So an
operator who sets 32 is accepting a one-second freeze from a single upload,
three times the default's, which is a real choice and is why it is the most
the app will accept.

Refused rather than clamped, and that is the more important half. A limit
that silently reduces your value honours itself and discards your intent:
your import goes on failing, for a reason your own configuration says should
not apply, with nothing anywhere connecting the two.

### This limit is per upload, not per server

Worth knowing before you raise it. Nothing queues imports, so two people
importing at once, or one person with two tabs, both happen. The limit on
[how many uploads one account may make](#how-many-uploads-one-account-may-make)
counts uploads over 15 minutes; it does not stop two from running at once.

Memory does not add up the way you would expect, because the imports do not
actually overlap: the server parses them one after another, so two 32 MB
imports peak at 587 MB rather than twice 467 MB. What adds up is the wait.
Two simultaneous 32 MB imports hold the server for **1007 ms at a stretch**,
during which it answers nothing at all, and four take 3.9 seconds. At the
default of 8 the same figures are 290 ms and 502 ms.

So the limit bounds what one upload costs, and the total is yours to manage.
If your instance has several active users, that is an argument for leaving
the default alone rather than raising it.

Any value different from 8 is also named in the startup log, alongside the
default. That line exists for the person reading logs after an incident, who
is usually not the person who changed the setting.
