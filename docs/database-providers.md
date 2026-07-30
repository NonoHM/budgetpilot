# Using PostgreSQL or MySQL (optional)

BudgetPilot runs on SQLite by default, and that is the setup it is built
for: no server, no password, and the whole database is one file you can
copy. A household budget is a few thousand rows. SQLite is not a limitation
you will grow out of.

This page is for the case where you'd rather not run one anyway: you already
operate a PostgreSQL or MySQL server, your backups are built around it, or
your storage layout keeps databases somewhere other than the application. If
none of that describes you, close this page — nothing here makes the app
faster or safer.

## What you're choosing between

|                 | SQLite (default)   | PostgreSQL / MySQL           |
| --------------- | ------------------ | ---------------------------- |
| Extra container | none               | one, plus its own volume     |
| Configuration   | nothing to set     | two variables and a password |
| Backup          | copy one file      | `pg_dump` / `mariadb-dump`   |
| Upgrades        | migrations at boot | migrations at boot           |
| Features in-app | everything         | everything                   |

The last two rows are the point: nothing in the app is engine-specific, and
no feature waits behind a server engine. What you buy is operational, and
what you pay is a second container to keep alive.

MySQL and MariaDB are the same choice: they share one connection protocol,
and `DATABASE_PROVIDER=mysql` covers both. The overlay below runs MariaDB,
which is what CI and the image smoke test exercise on every change.

**There is no in-place conversion.** Switching an existing install means
exporting your data and importing it into a fresh one — see
[Switching an existing install](#switching-an-existing-install). Decide
before you have data you care about, if you can.

## Running the bundled server

Two optional overlays start the server for you, on the same internal Compose
network as the app, in the same way the AI and reverse-proxy overlays work.

### 1. Put a password in `.env`

```dotenv
DATABASE_PASSWORD=<the output of: openssl rand -hex 32>
```

There is no default and there is no fallback: with `DATABASE_PASSWORD`
unset, Compose refuses to start the stack and says so. That is deliberate —
the alternative is a database whose password is a value published in this
repository.

`.env` is where it lives, and `.env` never goes into version control or into
the same archive as a database backup.

### 2. Start the stack with the overlay

PostgreSQL:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

MySQL/MariaDB:

```bash
docker compose -f docker-compose.yml -f docker-compose.mysql.yml up -d --build
```

Running the published image instead of building from source? Swap the base
file, everything else is identical:

```bash
docker compose -f docker-compose.prebuilt.yml -f docker-compose.postgres.yml up -d
docker compose -f docker-compose.prebuilt.yml -f docker-compose.mysql.yml up -d
```

Save yourself the repetition for every later command:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.postgres.yml
```

The overlay sets `DATABASE_PROVIDER` and `DATABASE_URL` itself, pointing at
the server it starts. **Adding it is the switch** — you don't also edit
those two variables in `.env`, and if you do, the overlay wins. This is the
same rule as the AI overlay: the stack can't end up with a database
container running while the app quietly writes to a file on the volume.

The app waits for the server to pass its own health check before it starts,
so the first `up` on a cold machine takes a few seconds longer than usual.
Migrations then run exactly as they do on SQLite.

Two things the overlays deliberately do not do:

- **Never stack both of them.** Both set `DATABASE_URL` and the last `-f`
  wins, so you'd be paying for a database server the app never opens.
- **Neither publishes the database port on the host.** The app reaches the
  server over the Compose network, which is all it needs. See
  [Connecting a client](#connecting-a-client) for the times you need more.

They stack with the AI and reverse-proxy overlays in any order:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml \
  -f docker-compose.ai.yml -f docker-compose.proxy.yml up -d --build
```

### The app's database account

**The account the app connects with is not a superuser**, on either engine.
BudgetPilot needs to own one database and nothing else, so that is all it
gets: the PostgreSQL overlay creates a plain `budgetpilot` login role and
hands it ownership of the `budgetpilot` database, and MariaDB's `budgetpilot`
user is scoped to the `budgetpilot` database the same way. There is nothing
for you to do — it happens the first time the stack creates its volume.

Each engine keeps one administrative account for the maintenance you might
one day need (a major-version upgrade, a restore), and neither is usable from
outside its own container:

- PostgreSQL's `postgres` ends up with **no password at all**, which no
  network login can satisfy. `docker compose exec postgres psql -U postgres`
  still works, because the server trusts its own local socket.
- MariaDB's `root` gets a random password and only accepts connections from
  `localhost`. That password is printed once in the container's log, so strip
  it before pasting logs anywhere.

Neither is a password you have to store, rotate, or type.

**If the app warns at startup that it has more privilege than it uses**, it
means this setup did not apply — an operator's own server where the account
was granted extra rights, or a volume created before this overlay existed.
The warning names the fix for your case, and there are only three:

- The role already owns its database: `ALTER ROLE "<role>" NOSUPERUSER;`, and
  revoke any `pg_execute_server_program`, `pg_write_server_files` or
  `pg_read_server_files` membership. Nothing the app does needs them.
- The role does not own the database it writes to: give it ownership first
  (`ALTER DATABASE <database> OWNER TO "<role>";`), then drop the excess. In
  that order — the extra privilege is what is letting it write today.
- The role is the cluster's **bootstrap** superuser (the one `initdb`
  created). PostgreSQL refuses to demote it, so there is nothing to alter:
  create a separate login role, hand it ownership of the database, and point
  `DATABASE_URL` at it. On the bundled overlay, a dump into a fresh volume is
  the shorter path.

Run those as a superuser, over the local socket:
`docker compose exec postgres psql -U postgres`.

**If the PostgreSQL container fails during its very first start**, remove the
volume rather than restarting it: `docker compose down -v` and start again.
The server sets up its account layout once, when the volume is created, and
never revisits it — a half-finished first start would otherwise be permanent.
This is safe only then, on a stack with no data yet; `-v` deletes everything
at any other time.

## Pointing at a server you already run

If you have a database server already, skip the overlays entirely and use
the base compose file with two variables in `.env`:

```dotenv
DATABASE_PROVIDER=postgresql
DATABASE_URL="postgresql://budgetpilot:yourpassword@db.example.lan:5432/budgetpilot"
```

```dotenv
DATABASE_PROVIDER=mysql
DATABASE_URL="mysql://budgetpilot:yourpassword@db.example.lan:3306/budgetpilot"
```

**Create the database and its user yourself first.** BudgetPilot applies its
own schema on every start, but it never creates the database, and it does
not need — or want — an account with permission to. Ownership of that one
database is the whole requirement: no superuser, no `CREATEDB`, no
`pg_execute_server_program`. The app says so at startup if it finds itself
with more, see [the app's database
account](#the-apps-database-account).

Details of both variables, including the accepted spellings, are in
[configuration](./configuration.md#database).

## Switching an existing install

There is no live migration between engines. The path is export, fresh
instance, import, and it goes through the app's own JSON backup, which is
engine-independent by design.

Do this per account: the export covers the account making it. On a
multi-account instance, every user exports their own file, and you import
each one while signed in as that user on the new instance.

1. **Export.** In the app, **Settings > Backup and restore > Export**. Keep
   the file somewhere other than the machine you're about to change.
2. **Back up what you already have**, in case you want to walk this back:
   the SQLite file (see [operations](./operations.md#backups)) and `.env`.
   `.env` matters as much as the database — without the original
   `TOTP_ENCRYPTION_KEY`, every two-factor setup in it is unreadable.
3. **Start an empty instance on the new engine.** Add `DATABASE_PASSWORD` to
   `.env`, then start the stack with the overlay as above. It comes up with
   no accounts, so you register again with your `BOOTSTRAP_TOKEN` exactly
   like a first install.
4. **Import.** Sign in, then **Settings > Backup and restore > Import**, and
   pick the file from step 1. This is a full replacement of that account's
   data, not a merge — which is what you want here, the account being empty.
5. **Check before you delete anything.** Transaction count, the last few
   months of the dashboard, your budgets and net worth accounts. The old
   SQLite volume is still there; nothing forces you to remove it today.

What does not carry across: your two-factor setup and your bank connections
are tied to the instance, not to the export. Set up TOTP again from
Settings, and reconnect banks from **Imports > Bank connections**.

## Backups

Your JSON export still works and is still the right tool for moving an
account's data around. What changes is the operator-level backup: there is
no longer a database file to copy. Use your engine's own dump tool —
commands and restore instructions are in
[operations](./operations.md#backups).

## Connecting a client

The database port is not published on the host, so `psql -h localhost` from
your laptop won't reach it. That is the intended posture: the server holds
every account's financial data and its password is the only thing in front
of it, so it stays on the Compose network.

When you need a shell, run it inside the container, where no port has to be
open at all:

```bash
docker compose exec postgres psql -U budgetpilot budgetpilot
docker compose exec mysql mariadb -u budgetpilot -p budgetpilot
```

If you genuinely need a host-side client — a GUI tool, a backup agent that
can't run in a container — publish the port to loopback only, in a
`docker-compose.override.yml` next to the others (Compose picks that file up
on its own, so it needs no `-f`):

```yaml
services:
  postgres:
    ports:
      - '127.0.0.1:5432:5432'
```

```yaml
services:
  mysql:
    ports:
      - '127.0.0.1:3306:3306'
```

`127.0.0.1:` is the part that matters, and it is the part that gets dropped
when someone retypes the line from memory. A bare `'5432:5432'` publishes on
every interface, which on most home routers means the database is reachable
from anything else on the network.

## When something's wrong

- **`required variable DATABASE_PASSWORD is missing a value`** — `.env` has
  no `DATABASE_PASSWORD`, or you're running the overlay from a directory
  that has no `.env`. Step 1 above.
- **The app container restarts in a loop on a fresh stack** — check the
  database container's logs first (`docker compose logs postgres`). The app
  waits for a healthy server, so a server that never becomes healthy (an
  unreadable volume, a password changed after the volume was created) shows
  up as an app that can't start.
- **The app starts but every screen is empty** — you're on the wrong
  database. `docker compose logs budgetpilot | grep database-provider`
  prints which engine it actually resolved at boot.
- **`P1013` or a scheme complaint at startup** — `DATABASE_PROVIDER` and the
  scheme of `DATABASE_URL` disagree. Use `postgresql://` with `postgresql`,
  `mysql://` with `mysql`. The app refuses to start on a mismatch rather
  than connecting to something you didn't mean.
- **`P1013: invalid port number in database URL`, with a `DATABASE_PASSWORD`
  you're sure of** — the password contains a character a URL reads as
  punctuation. A `/` ends the host part, and `+` can be read as a space. This
  is what a base64 password does to you; `openssl rand -hex 32` cannot.
  Regenerate it, and remember the server keeps the old one until you delete
  its volume.
- **Pasting logs for help** — `docker compose logs mysql` includes a
  `GENERATED ROOT PASSWORD` line from the server's very first start. Nothing
  uses that account and it only accepts connections from inside its own
  container, but strip the line anyway before it goes in an issue or a
  forum post.

More in [troubleshooting](./troubleshooting.md).
