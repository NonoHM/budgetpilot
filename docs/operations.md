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
Ollama models. There is no undo.

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

### Before you upgrade past 0.2.0

Three changes need a look at your `.env` first, because each can stop an
instance that works today.

**`BOOTSTRAP_TOKEN` is now required** whenever `REGISTRATION_MODE` is
`admin_only`, which is the default. An instance that bootstrapped long ago
and has since blanked the value used to run fine; it now refuses to start,
with `BOOTSTRAP_TOKEN is required when REGISTRATION_MODE=admin_only` in the
logs. Put any long random value back (`openssl rand -base64 32`), or set
`REGISTRATION_MODE=open` if that's genuinely what you want. The old
behaviour was to accept the blank value and silently reject every
registration attempt, which is the bug being fixed.

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

Two options, and they answer different questions.

### The whole database file

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

### The JSON export

In the app, **Settings > Backup and restore** exports everything belonging
to _your_ account as a single JSON file: transactions, categories, budgets,
rules, net worth accounts, savings goals.

Importing it back is a **full replacement**, not a merge. It wipes that
account's current data and rebuilds it from the file. That's what makes it
the right tool for moving your data to a fresh instance, and the wrong tool
for merging two accounts.

## Moving to another machine

1. Back up the database file as above.
2. Install BudgetPilot on the new machine, following
   [getting started](./getting-started.md), but stop before creating an
   account.
3. Copy your old `.env` across, or at minimum the same three secrets. A
   different `TOTP_ENCRYPTION_KEY` means every two-factor setup in the
   restored database is unreadable.
4. Restore the database file with the `docker compose cp` command above.
5. Adjust `ORIGIN` if the URL changed.

## Where your data actually is

|                          | Docker                                               | No Docker                      |
| ------------------------ | ---------------------------------------------------- | ------------------------------ |
| Database                 | `budgetpilot_data` volume, mounted at `/data/dev.db` | `./dev.db` in the checkout     |
| Secrets and settings     | `.env` next to your compose file                     | `.env` in the checkout         |
| Ollama models (if AI on) | `ollama_data` volume                                 | wherever Ollama installed them |

Nothing else leaves the machine. There's no telemetry, no phone-home, no
account on anyone's server.

## Uninstalling

```bash
docker compose down -v      # deletes the container AND all data volumes
docker image rm ghcr.io/nonohm/budgetpilot:latest
```

Then delete the folder. Export your data first if you want to keep it.
