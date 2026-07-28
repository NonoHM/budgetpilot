# Getting started

From nothing to a running BudgetPilot you can log into. Every command here is
meant to be copy-pasted as-is. If you've never used Docker or a terminal
before, you can still get through this: follow the boxes in order and don't
skip the checks.

Three ways to run it, pick one:

| Path                                                                | For you if                             | Time    |
| ------------------------------------------------------------------- | -------------------------------------- | ------- |
| [Docker, published image](#option-a-docker-published-image-easiest) | You just want to use the app           | ~2 min  |
| [Docker, built from source](#option-b-docker-built-from-source)     | You want to run your own modifications | ~10 min |
| [No Docker](#option-c-no-docker-node-directly)                      | You're going to work on the code       | ~10 min |

If you're not sure, take option A.

---

## Before you start

You need **Docker** for options A and B. Run this:

```bash
docker compose version
```

If it prints something like `Docker Compose version v2.30.0` (v2 or newer),
you're set. If it says "command not found", install
[Docker Desktop](https://docs.docker.com/get-started/get-docker/) (Windows,
macOS) or Docker Engine with the Compose plugin (Linux), then come back and
run the check again.

On Windows, run everything below from **Git Bash** or **WSL**, not from
PowerShell. The `openssl` and `cat > file <<EOF` commands won't work in
PowerShell.

---

## Option A: Docker, published image (easiest)

No clone, no build, no Node.js. You download one file, generate three
secrets, and start the app.

### 1. Make a folder and grab the compose file

```bash
mkdir budgetpilot && cd budgetpilot
curl -O https://raw.githubusercontent.com/NonoHM/budgetpilot/main/docker-compose.prebuilt.yml
```

### 2. Create your `.env`

BudgetPilot needs three secrets: one to gate account creation, one to hash
the identifiers used by login rate limiting, one to encrypt two-factor
secrets at rest. This block generates all three and writes the file for you.
Paste it whole:

```bash
cat > .env <<EOF
BOOTSTRAP_TOKEN=$(openssl rand -base64 32)
RATE_LIMIT_HASH_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
APP_PORT=3000
ORIGIN=http://localhost:3000
EOF
```

Check it worked:

```bash
cat .env
```

You should see five lines, each with a long random value after the `=`. If
any value is empty, `openssl` isn't installed. Install it, or see
[generating secrets without openssl](#generating-secrets-without-openssl)
below.

Values ending in `=`, or containing `+` and `/`, are normal. That's what
base64 looks like, not a broken copy-paste.

> **Port 3000 already used** by something else on your machine? Change
> **both** `APP_PORT` and `ORIGIN` to the same new port before starting, for
> example `APP_PORT=3001` and `ORIGIN=http://localhost:3001`. Changing only
> one of them breaks every form in the app. See
> [troubleshooting](./troubleshooting.md#every-form-fails-with-cross-site-post-form-submissions-are-forbidden).

### 3. Start it

```bash
docker compose -f docker-compose.prebuilt.yml up -d
```

First run downloads the image, which takes a minute or two. `-d` means it
keeps running in the background after the command returns.

### 4. Check it's alive

```bash
docker compose -f docker-compose.prebuilt.yml logs budgetpilot
```

You want these two lines near the end:

```
[budgetpilot] startup: PUBLIC_INSTANCE=unset (defaults to secure) cookies-secure=true
Listening on http://0.0.0.0:3000
```

(If you used `npm run setup` rather than the `.env` block above, the first
line reads `PUBLIC_INSTANCE=true` instead. Same thing: the flag defaults to
on when it isn't set at all.)

`0.0.0.0:3000` is the port _inside_ the container, which never changes. The
one you open in the browser is your `APP_PORT`.

`cookies-secure=true` is the default and the right value here: browsers
accept a `Secure` cookie over `http://localhost`. If you plan to reach the
app from another device on your LAN instead, read
[reaching it from another device](#reaching-it-from-another-device) before
you try.

If instead you see the container restarting in a loop, jump to
[troubleshooting](./troubleshooting.md).

### 5. Create your account

Open **http://localhost:3000** (or your custom port). You'll land on the
login page. Click "create an account".

Registration is closed by default, so the form asks for a token. It's the
`BOOTSTRAP_TOKEN` in your `.env`:

```bash
grep BOOTSTRAP_TOKEN .env
```

Copy the value after the `=` (the whole thing, including a trailing `=` if
there is one) and paste it into the form. The first account created this way
becomes the admin automatically.

The interface starts in French. Switch to English from **Settings**, under
**Language**, if you prefer.

You're done. Next: [put some data in it](#first-steps-in-the-app).

---

## Option B: Docker, built from source

Same result as option A, except the image is built from your local checkout,
so any change you make to the code ends up in it.

```bash
git clone https://github.com/NonoHM/budgetpilot.git
cd budgetpilot
npm run setup
docker compose up -d --build
```

`npm run setup` asks four questions (Docker or not, optional AI, optional
bank sync), then writes a complete `.env` with three freshly generated
secrets. It only uses Node.js built-ins, so it works on a fresh clone
without running `npm install` first. It also detects if port 3000 is taken
and offers you a free one, keeping `APP_PORT` and `ORIGIN` in sync for you.

No Node.js on the machine? Skip `npm run setup` and write the `.env` by hand
with the block from [option A step 2](#2-create-your-env). It's the same
file, the script just saves you the typing.

`--build` compiles the image. The first build takes 5 to 10 minutes because
two dependencies (bcrypt, better-sqlite3) are compiled from source inside
the container. That's normal, not a hang. You need `--build` again after
every code change.

Then follow [step 4](#4-check-its-alive) and
[step 5](#5-create-your-account) above, dropping the
`-f docker-compose.prebuilt.yml` from the log command:

```bash
docker compose logs budgetpilot
```

---

## Option C: No Docker, Node directly

This runs the Vite dev server, with hot reload. It's the contributor setup,
not a way to run the app long-term.

**Prerequisites:** Node.js 24.18.0 (the version in `.nvmrc`), and a working
C++ toolchain, because bcrypt and better-sqlite3 compile native code during
`npm install`:

- Debian/Ubuntu: `sudo apt install python3 build-essential pkg-config`
- macOS: `xcode-select --install`
- Windows: use WSL, don't fight this natively

If you use [nvm](https://github.com/nvm-sh/nvm), `nvm install && nvm use`
picks up the right Node version from `.nvmrc`. Otherwise install 24.18.0
however you normally do.

```bash
git clone https://github.com/NonoHM/budgetpilot.git
cd budgetpilot
npm install
npm run setup          # answer "n" to the Docker question
npx prisma generate
npx prisma migrate dev
npm run dev
```

Open **http://localhost:5173** and create your account with the
`BOOTSTRAP_TOKEN` from `.env`, same as
[step 5](#5-create-your-account) above.

Your database is a single file, `dev.db`, at the root of the checkout.

---

## Reaching it from another device

Everything above assumes you open the app on the machine running it, at
`http://localhost:3000`. Two extra lines are needed to reach it from your
phone or laptop instead, and skipping them is the single most common way to
get stuck.

Over plain HTTP on your LAN, at the machine's own address:

```dotenv
ORIGIN=http://192.168.1.42:3000
PUBLIC_INSTANCE=false
```

Both matter. `ORIGIN` has to be the exact URL you type, or every form
returns a 403. `PUBLIC_INSTANCE=false` drops the `Secure` flag from the
session cookie, which browsers otherwise refuse to store on a plain-HTTP
address that isn't `localhost`, leaving you logged out on every page load.
The app prints a warning at startup while this is on, because your session
cookie then travels in clear text on your network. That is a reasonable
trade on a home LAN and not one to make anywhere else.

Restart after editing, then check the logs say what you expect:

```
[budgetpilot] startup: PUBLIC_INSTANCE=false cookies-secure=false
```

Want a real domain and HTTPS instead? That's a Caddy overlay and three
commands: see [reverse proxy](./reverse-proxy.md). Leave
`PUBLIC_INSTANCE` alone in that case.

---

## First steps in the app

A fresh account is empty apart from 14 default categories. Two ways to fill
it:

**Import a statement** (Imports > Import statement). CSV and XLSX are
accepted, with these profiles:

| Profile          | What it is                                                    |
| ---------------- | ------------------------------------------------------------- |
| Auto             | Detects one of the below from the file's header row           |
| Banque Populaire | Their statement export                                        |
| Revolut          | Their statement export                                        |
| Home             | BudgetPilot's own CSV export, so an export re-imports cleanly |
| Generic          | Any CSV you can shape yourself, see below                     |

Your bank isn't listed? Use **Generic**. Reshape your export to exactly
these columns:

```csv
date,label,amount,category
2026-01-15,CARREFOUR MARKET,-42.30,Alimentation
2026-01-28,SALAIRE,2450.00,
```

- `date`, `label` and `amount` are required, `category` is optional and can
  be left empty.
- No other column is allowed, the import refuses the file rather than
  guessing.
- Dates are `YYYY-MM-DD` or `DD/MM/YYYY`.
- Amounts are signed: negative is an expense, positive is income. A zero
  amount is rejected.

Duplicates are detected, so re-importing an overlapping statement won't
double your transactions.

**Or enter transactions by hand** from the Transactions page, if you just
want to try it out.

Once there's data in there: set a monthly budget per category (Budgets),
declare your accounts (Net worth), and let the categorization rules (Rules)
classify future imports for you.

---

## Generating secrets without openssl

If `openssl` isn't available, any of these produce an equivalent value.

With Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # BOOTSTRAP_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # the other two
```

With Python 3:

```bash
python3 -c "import secrets,base64;print(base64.b64encode(secrets.token_bytes(32)).decode())"  # BOOTSTRAP_TOKEN
python3 -c "import secrets;print(secrets.token_hex(32))"                                      # the other two
```

`RATE_LIMIT_HASH_SECRET` and `TOTP_ENCRYPTION_KEY` must be 64 hex characters
exactly. `BOOTSTRAP_TOKEN` has no format constraint, it just needs to be long
and random. Use three different values, never the same one twice.

---

## Where to go next

- [Configuration](./configuration.md): every setting, and how to reach the
  app from your phone or another machine.
- [Reverse proxy](./reverse-proxy.md): a real domain with automatic HTTPS,
  via the optional Caddy overlay.
- [Operations](./operations.md): updating, backups, moving to another
  machine.
- [Local AI advice](./ai-insights.md): the optional Ollama setup.
- [Bank sync](./bank-sync.md): the optional automatic PSD2 connection.
- [Troubleshooting](./troubleshooting.md): when something's broken.
