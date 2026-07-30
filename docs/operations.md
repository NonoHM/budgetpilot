# Running it day to day

Updating, backing up, moving machines, shutting down. Everything here
assumes Docker.

If you run the published image, every `docker compose` command below needs
`-f docker-compose.prebuilt.yml`. Save yourself the typing by setting this
once per terminal:

```bash
export COMPOSE_FILE=docker-compose.prebuilt.yml
```

Then plain `docker compose ...` works as written.

## Everyday commands

```bash
docker compose ps                    # is it running?
docker compose logs -f budgetpilot   # follow the logs, Ctrl+C to stop watching
docker compose restart               # restart, e.g. after editing .env
docker compose stop                  # stop, keep everything
docker compose down                  # stop and remove the container, keep your data
```

`docker compose down` is safe. **`docker compose down -v` is not**: the `-v`
deletes the named volumes, which means your database and any downloaded
Ollama models. Nothing undoes it.

## Updating

**Published image:**

```bash
docker compose pull
docker compose up -d
```

**Built from source:**

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically when the container starts, so there's
no separate step and your data carries across the update. Take a backup
first anyway, see below.

### Before you upgrade past 0.2.2

**Category names that differ only in case or accents become one category.**
"Courses" and "courses", "Café" and "Cafe" used to be two separate
categories. From this version they are the same one, everywhere: budgets,
category natures, reports, and the import rules that already worked this
way.

This is a consistency fix, not a new feature. Rules and label search have
always matched names this way, so a budget on "Courses" already looked
broken to anyone who had also pinned transactions to "courses": the spending
simply never counted. Now it does.

What happens on your data, once, the first time the new version starts:

- Categories, import buckets, budgets, and category natures whose names fold
  together are merged into the oldest of them. Transactions follow.
- For a budget or a nature, the value kept is the one you edited most
  recently.
- Import buckets pointing at different bank connections or different
  provider accounts are **not** merged, because that would drop a real link.
  You get a warning in the logs naming how many.
- Net worth accounts are **not** merged either, because merging balances and
  snapshot histories has no automatic answer. Existing pairs keep working.
  Only creating or renaming one onto another is refused from now on.

Once the merge has run, the database itself enforces the rule, not just the
app: two categories, two budgets, or two category natures whose names fold
together can no longer exist at all. Import buckets and net worth accounts
are the two exceptions, and stay checked by the app alone, because both have
a state a database constraint cannot express: the pair of buckets left
unmerged just above, and a deleted net worth account that keeps its history.

Read exactly what will change on your own data before upgrading:

```bash
docker compose run --rm budgetpilot npm run db:normalize-names -- --dry-run
```

That prints every merge it would make, by name, and writes nothing. Take a
backup first either way, see [Backups](#backups).

**One more one-time step runs at the same start**, and this one changes
nothing you can see. The app computes a fingerprint for each imported
transaction, used to recognise a row you already have when you re-import a
statement. It now compares those fingerprints itself instead of leaving the
comparison to the database, which is what lets BudgetPilot run on PostgreSQL
and MySQL. You get one log line, `[dedupe-keys] hashing existing
deduplication keys, this runs once`, and nothing else: no transaction is
merged, moved, or dropped.

**PostgreSQL and MySQL/MariaDB are supported from this version.** Nothing
changes for you if you do nothing: SQLite stays the default and stays the
recommended setup. See [using PostgreSQL or MySQL](./database-providers.md)
if you want to move to a server engine — there are two optional Compose
overlays that run one for you — and note that moving an existing install
means exporting your data and importing it into an empty instance. There is
no in-place conversion.

### Before you upgrade past 0.2.0

Two changes need a look at your `.env` first, and one is worth knowing
about.

**`BOOTSTRAP_TOKEN` is now required to bootstrap.** If
`REGISTRATION_MODE=admin_only` (the default), the token is blank, **and no
admin account exists yet**, the app refuses to start rather than accepting
the blank value and silently rejecting every registration attempt, which is
the bug being fixed. Generate one (`openssl rand -base64 32`), or set
`REGISTRATION_MODE=open` if that's genuinely what you want.

An instance that already has its admin account is unaffected: a blank token
there just means nobody can register except through an invitation link from
the admin panel, which is a normal way to run a finished instance. You get a
warning in the logs, not a crash.

**`PUBLIC_INSTANCE=false` now really does drop the `Secure` flag** from the
session cookie, and HSTS with it. It used to be a no-op under Docker, where
`NODE_ENV=production` forced both on regardless. If you have that line in
your `.env` while serving the app over HTTPS, remove it: it was expressing
the opposite of what you want and is no longer ignored. If you set it
because you're on a plain-HTTP LAN, it now works as documented and login
stops bouncing you back to the login page.

**The AI overlay forces `LLM_ENABLED=true`.** If you run
`-f docker-compose.ai.yml` while your `.env` says `LLM_ENABLED=false`,
expecting no LLM at all, drop the overlay from your command instead. Adding
it is now the opt-in. Nothing is sent anywhere without a user also enabling
AI advice on their own account.

To pin a version instead of tracking `latest`, set it in `.env`:

```dotenv
BUDGETPILOT_VERSION=0.2.0
```

Release notes are in [CHANGELOG.md](../CHANGELOG.md).

## Serving it over HTTPS

Reaching the app from outside the machine it runs on means a certificate.
There's an optional Caddy overlay for that, which handles Let's Encrypt on
its own: see [reverse proxy](./reverse-proxy.md). A LAN-only instance over
plain HTTP doesn't need it, see
[configuration](./configuration.md#public_instance-and-the-session-cookie).

## Backups

Two options, and they answer different questions: a full copy of the
database, which is what you restore from, and the in-app JSON export, which
is what you move one account's data with.

If you run PostgreSQL or MySQL instead of the default SQLite, the first one
is a dump rather than a file copy — skip to [PostgreSQL or
MySQL](#the-whole-database-on-postgresql-or-mysql). Everything else on this
page is the same on every engine.

### The whole database file (SQLite)

This is the real backup: every user, every setting, every transaction.

```bash
docker compose stop
docker compose cp budgetpilot:/data/dev.db ./budgetpilot-backup.db
docker compose start
```

Stopping first matters. Copying a SQLite file while the app is writing to it
can hand you a truncated database that looks fine until you need it.

Restoring is the same move in reverse:

```bash
docker compose stop
docker compose cp ./budgetpilot-backup.db budgetpilot:/data/dev.db
docker compose start
```

Outside Docker, the database is just `dev.db` at the root of the checkout.
Copy the file.

### The whole database on PostgreSQL or MySQL

There is no file to copy: use the engine's own dump tool, which is the only
thing that can produce a consistent snapshot while the app keeps running.
The commands below assume the bundled overlays from [using PostgreSQL or
MySQL](./database-providers.md), where the server runs as a service next to
the app. Pointing at a server you run yourself is the same command with your
own host and credentials.

BudgetPilot ships no backup wrapper on purpose. A wrapper that silently
produces a corrupt dump is worse than a one-liner you can read.

**PostgreSQL:**

```bash
docker compose exec -T postgres pg_dump -U budgetpilot -Fc budgetpilot > ~/budgetpilot-backup.dump
```

Restoring, into a stopped app so nothing writes underneath you:

```bash
docker compose stop budgetpilot
docker compose exec -T postgres pg_restore -U budgetpilot -d budgetpilot --clean --if-exists < ~/budgetpilot-backup.dump
docker compose start budgetpilot
```

**MySQL/MariaDB:**

```bash
docker compose exec -T mysql mariadb-dump -u budgetpilot -p --single-transaction budgetpilot > ~/budgetpilot-backup.sql
```

```bash
docker compose stop budgetpilot
docker compose exec -T mysql mariadb -u budgetpilot -p budgetpilot < ~/budgetpilot-backup.sql
docker compose start budgetpilot
```

`--single-transaction` is what makes the dump consistent without locking the
app out of its own tables. `-p` prompts for the password rather than taking
it on the command line, where it would land in your shell history and in the
process list; it is the `DATABASE_PASSWORD` from your `.env`.

The `~/` in those paths is deliberate: the dump holds every account's data,
password hashes and encrypted two-factor secrets, so it does not belong in a
checkout of a public repository where one `git add -A` publishes it. Treat it
exactly like the SQLite file — same care, same place, not next to the compose
file.

Two things this backup does not contain, on any engine: `.env` (see the next
section — the dump is useless without it) and the volume itself. Restoring
into a database whose schema is older than the dump is fine; the app runs
its migrations at the next start.

### The encryption key

`TOTP_ENCRYPTION_KEY` lives in `.env`, never in the database. A database
backup does not contain it. Back it up separately, in a password manager or
wherever you keep your other secrets, and keep it out of the same archive as
the database copy.

That key encrypts two things at rest:

- two-factor (TOTP) secrets,
- bank connection credentials, for connectors that store any.

Restoring a database next to the wrong key plays out like this:

- With `TOTP_ENCRYPTION_KEY` unset, the app refuses to start. You cannot get
  this wrong quietly.
- With a different key, the app starts normally and every stored two-factor
  secret becomes unreadable. Nothing warns you until an affected user tries
  to sign in.
- Those users can still sign in with a **recovery code**. Recovery codes are
  hashed, not encrypted, so they survive a key change. Tell them to turn
  two-factor off and set it up again straight after.
- A user with two-factor on and no recovery code left is locked out for
  good. An admin password reset does not clear two-factor, and no admin
  action can disable someone else's. Deleting and recreating the account is
  the only way back, and it loses that account's data.
- Bank connections recover on their own: reconnect the bank from
  **Imports > Bank connections**.

There is no way to read the encrypted values back without the original key.
Losing it is permanent. See
[configuration](./configuration.md#the-three-secrets) for the other two
secrets and how they behave.

### The JSON export

In the app, **Settings > Backup and restore** exports everything belonging
to _your_ account as a single JSON file: transactions, categories, budgets,
rules, net worth accounts, savings goals.

Importing it back is a **full replacement**, not a merge. It wipes that
account's current data and rebuilds it from the file. That's what makes it
the right tool for moving your data to a fresh instance, and the wrong tool
for merging two accounts.

## Moving to another machine

1. Back up the database as above — the file on SQLite, a dump on PostgreSQL
   or MySQL.
2. Install BudgetPilot on the new machine, following
   [getting started](./getting-started.md), but stop before creating an
   account.
3. Copy your old `.env` across, or at minimum the same three secrets. A
   different `TOTP_ENCRYPTION_KEY` means every two-factor setup in the
   restored database is unreadable, permanently. See
   [the encryption key](#the-encryption-key).
4. Restore the database with the matching command above (`docker compose cp`
   on SQLite, `pg_restore` or `mariadb` on a server engine).
5. Adjust `ORIGIN` if the URL changed.

## Where your data actually is

|                          | Docker                                               | No Docker                      |
| ------------------------ | ---------------------------------------------------- | ------------------------------ |
| Database (SQLite)        | `budgetpilot_data` volume, mounted at `/data/dev.db` | `./dev.db` in the checkout     |
| Database (PostgreSQL)    | `postgres_data` volume, or your own server           | your own server                |
| Database (MySQL)         | `mysql_data` volume, or your own server              | your own server                |
| Secrets and settings     | `.env` next to your compose file                     | `.env` in the checkout         |
| Ollama models (if AI on) | `ollama_data` volume                                 | wherever Ollama installed them |

Nothing else leaves the machine: no telemetry, no phone-home, no account on
anyone's server.

## Uninstalling

```bash
docker compose down -v      # deletes the container AND all data volumes
docker image rm ghcr.io/nonohm/budgetpilot:latest
```

Then delete the folder. Export your data first if you want to keep it.
