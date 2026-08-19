# Troubleshooting

Known gotchas, roughly in the order people hit them. Something else broken?
[Open an issue](https://github.com/NonoHM/budgetpilot/issues), this page is
a list of traps, not a bug tracker.

First reflex, always:

```bash
docker compose logs budgetpilot
```

(add `-f docker-compose.prebuilt.yml` if you run the published image)

---

## The container starts and immediately dies, over and over

Look at the last lines of the logs. If it says:

```
Error: RATE_LIMIT_HASH_SECRET is required (set it in your environment)
```

or the same for `TOTP_ENCRYPTION_KEY`, that variable is empty or missing in
`.env`. Generate a value, restart. The crash is deliberate: the app refuses
to run with a security control switched off.

```bash
cat .env    # every one of the three secrets should have a long value
```

If instead the logs show a Prisma error code such as `P3009` or `P3018`, a
database migration failed and the app is refusing to serve against a
half-migrated database. Do not delete the volume: see
[If a migration fails partway](./operations.md#if-a-migration-fails-partway).

## Registration always says the token is invalid

You paste the `BOOTSTRAP_TOKEN` and the form rejects it every time.

It's a copy-paste problem. Copy the entire value after the `=`, including
any trailing `=` characters, with no leading or trailing space and no line
break in the middle:

```bash
grep BOOTSTRAP_TOKEN .env
```

An empty `BOOTSTRAP_TOKEN` is no longer a silent cause. Before your first
account exists, the app refuses to start without one
(`BOOTSTRAP_TOKEN is required to create the first account` in the logs).
After that, a blank value logs a warning saying registration now only works
through an invitation link. Either way it's in the logs, which it never used
to be.

Another possibility: you're using the value from a `.env` you regenerated
since. `npm run setup` rewrites all three secrets every time it runs, so an
older token is dead.

## Every form fails with "Cross-site POST form submissions are forbidden"

Pages load, but login, registration and every other submission return a 403.

`ORIGIN` in `.env` doesn't match the URL in your address bar. It has to be
exact: same protocol, same host, same port, no trailing slash.

| You open                     | `ORIGIN` must be             |
| ---------------------------- | ---------------------------- |
| `http://localhost:3001`      | `http://localhost:3001`      |
| `http://192.168.1.42:3000`   | `http://192.168.1.42:3000`   |
| `https://budget.example.com` | `https://budget.example.com` |

If you changed the port and your `.env` has **no** `ORIGIN` line, there is
nothing else to do: compose builds `ORIGIN` from `APP_PORT`, so the two cannot
drift apart. If your `.env` **does** set `ORIGIN`, that line wins over the
default and both values have to move together — or delete the line and let the
default do it. Restart after editing.

## Login succeeds then bounces me straight back to the login page

You're reaching the app over plain HTTP at something that isn't localhost:
a LAN address like `http://192.168.1.42:3000`, or a bare hostname.

The session cookie carries the `Secure` flag by default, and browsers refuse
to store a `Secure` cookie on a plain-HTTP origin unless it's `localhost` or
`127.0.0.1`. So the login itself works, the cookie is thrown away, and the
next page load looks logged-out.

Fix it by telling the app this is a LAN instance:

```dotenv
PUBLIC_INSTANCE=false
```

Restart, and the startup log should read `cookies-secure=false`. Your
session cookie then travels in clear text on your network, which is the
trade you're making. Do it on a network you trust, never on an
internet-reachable instance.

Prefer HTTPS? Put a certificate in front of it with the
[Caddy overlay](./reverse-proxy.md) and leave `PUBLIC_INSTANCE` alone. Or
tunnel, so the browser still talks to localhost:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

Full explanation in
[configuration](./configuration.md#public_instance-and-the-session-cookie).

## Port is already allocated

```
Error response from daemon: ... bind: address already in use
```

Something else on the machine owns that port. Find what:

```bash
# Linux/macOS
lsof -i :3000
```

Then either stop it, or move BudgetPilot: set `APP_PORT` to a free port in
`.env` and start again. `ORIGIN` follows on its own unless your `.env` sets it
explicitly, in which case move that too.

## `docker compose up` says the .env file is missing

```
env file /path/to/.env not found
```

You're either in the wrong folder, or you never created `.env`. It has to
live next to the compose file. See
[getting started, step 2](./getting-started.md#2-create-your-env).

## `npm install` fails while building bcrypt or better-sqlite3

Both compile native code, so they need a C++ toolchain:

- Debian/Ubuntu: `sudo apt install python3 build-essential pkg-config`
- macOS: `xcode-select --install`
- Windows: use WSL

This only affects the no-Docker setup. The Docker images already contain
what's needed.

## The Docker build takes forever

The first `--build` takes 5 to 10 minutes, most of it compiling those same
two native dependencies inside the container. That's expected. Later builds
reuse the cache and are much faster.

Don't want to build at all? Use the published image, see
[getting started option A](./getting-started.md#option-a-docker-published-image-easiest).

## The interface is in French

That's the default locale, not a bug. **Settings**, first option, switch to
English. The choice is stored in a cookie per browser.

## No AI card on the dashboard

Covered in detail in [local AI advice](./ai-insights.md#nothing-shows-up).
The short version: `LLM_ENABLED=true` in `.env`, the per-user switch on in
Settings, and the model in `LLM_MODEL` actually pulled.

## My CSV import is rejected

**You don't have to reshape your file.** If BudgetPilot can't read it, the
import summary offers **Designate the columns**, and you tell it which column
holds the date, the label, and the amount. It remembers your answer, so the
next statement from that bank imports without asking.

Extra columns are fine. BudgetPilot ignores what it doesn't recognise and
imports the rest, so a bank export with fifteen columns works when three of
them are the ones it needs.

### Why this works

```csv
Date,Libellé,Montant,Solde,Référence
01/06/2026,MERCERIE LAFAYETTE,-45.20,1204.80,REF000101
```

Three columns are recognised by name, `Solde` and `Référence` are ignored, and
the file imports. Accented spellings work too.

### Why this doesn't

```csv
Date,Libellé,Débit,Crédit
01/06/2026,MERCERIE LAFAYETTE,45.20,
```

The amount is split across two columns. Designating one of them would drop
every row carried by the other, so BudgetPilot refuses the file instead of
importing half your statement. Combine the two into one signed column, where
an expense is negative.

Two more refusals you can act on:

- **A date it can't read.** The message shows the value it read and the forms
  it accepts, for example `date non reconnue : « 01/06/26 » (attendu :
JJ/MM/AAAA ou AAAA-MM-JJ)`. Accepted forms are listed in the
  [import reference](./reference/imports.md#accepted-date-formats).
- **A currency that isn't euros.** BudgetPilot stores euros only, so a file
  declaring `GBP` is refused rather than relabelled.

If your statement has no header row at all, open **Designate the columns** and
turn on **The first row contains data**. Without it, BudgetPilot reads your
first transaction as a title and you lose it.

Still stuck? A new import profile is a welcome contribution, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## I lost my two-factor device

Use one of the recovery codes shown when you enabled it. No admin override
exists, by design: an admin who could disable someone else's second factor
would be a way around it.

Out of recovery codes too? The only way back in is direct database surgery
on `dev.db`, so take that backup.
