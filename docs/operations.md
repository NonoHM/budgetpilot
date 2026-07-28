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

To pin a version instead of tracking `latest`, set it in `.env`:

```dotenv
BUDGETPILOT_VERSION=0.2.0
```

Release notes are in [CHANGELOG.md](../CHANGELOG.md).

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
