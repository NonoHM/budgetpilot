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

The published image is multi-arch (`linux/amd64` and `linux/arm64`): Docker
pulls the right one automatically, whether you're on a regular PC/server or
an arm64 machine (Raspberry Pi 4/5, Apple Silicon, AWS Graviton).

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
BUDGETPILOT_VERSION=$(curl -fsSL https://api.github.com/repos/NonoHM/budgetpilot/releases/latest \
  | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4 | sed 's/.*v//')

cat > .env <<EOF
BOOTSTRAP_TOKEN=$(openssl rand -base64 32)
RATE_LIMIT_HASH_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
BUDGETPILOT_VERSION=${BUDGETPILOT_VERSION:?Could not reach the Releases API. Take the number from https://github.com/NonoHM/budgetpilot/releases/latest and run BUDGETPILOT_VERSION=x.y.z, then paste this block again.}
APP_PORT=3000
EOF
```

Check it worked:

```bash
cat .env
```

You should see five lines. The first three carry a long random value after
the `=`, and `BUDGETPILOT_VERSION` carries a version number like `0.13.1`. If
any of the three secrets is empty, `openssl` isn't installed. Install it,
or see [generating secrets without openssl](#generating-secrets-without-openssl)
below.

### Why the version line matters

`BUDGETPILOT_VERSION` is the version you will be running, and it is worth one
paragraph because getting it wrong is quiet rather than loud.

Leave it out and the compose file uses `latest`. That sounds like "always
current" and is not: `up -d` starts whatever image your machine downloaded last
time, which may be months old, and nothing tells you. Pin it and you can always
answer "which version am I on". The app shows the same number on its
**Settings** screen once you are in.

The block looks the version up rather than printing one on this page, because a
number written here would be wrong the day after the next release and nobody
would notice. **If the lookup cannot reach GitHub, no `.env` is written.** The
block stops and tells you where to find the number by hand. That is on purpose:
an empty value would silently go back to `latest`, which is the exact problem
the pin is here to prevent.

Choosing an older version on purpose is fine, and is what a pin is for. Running
one by accident is not, and that is what this avoids.

There is no `ORIGIN` line here, on purpose. The compose file works `ORIGIN` out
from `APP_PORT`, so a `.env` that says nothing about it always agrees with the
port you published. Write `ORIGIN` by hand and you opt out of that, and the two
drift apart the first time you change the port.

Values ending in `=`, or containing `+` and `/`, are normal. That's what
base64 looks like, not a broken copy-paste.

> **Port 3000 already used** by something else on your machine? Change
> `APP_PORT` to a free port, for example `APP_PORT=3001`, and open that port
> in your browser. There is nothing else to change: `ORIGIN` follows
> `APP_PORT` on its own as long as you have not written an `ORIGIN` line of
> your own. If you have, the two must name the same port, or every form in the
> app is refused. See
> [troubleshooting](./troubleshooting.md#every-form-fails-with-cross-site-post-form-submissions-are-forbidden).

### 3. Start it

```bash
docker compose -f docker-compose.prebuilt.yml pull
docker compose -f docker-compose.prebuilt.yml up -d
```

The `pull` is the step that fetches the version you pinned. `up -d` on its own
starts the image already in your local Docker cache and reports success either
way, so skipping the pull is how you end up running an older build than the one
in your `.env` with nothing on screen saying so.

First run downloads the image, which takes a minute or two. `-d` means it
keeps running in the background after the command returns.

### 4. Check it's alive

```bash
docker compose -f docker-compose.prebuilt.yml logs budgetpilot
```

You want these two lines near the end:

```
[budgetpilot] startup: PUBLIC_INSTANCE=unset (defaults to secure) cookies-secure=true database-provider=sqlite
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
login page.

**The interface picks its language from your browser**, so the exact wording
on screen depends on that and this guide names controls by what they do
rather than by their label. French and English are the two languages
shipped; a browser asking for anything else gets English. Below the sign-in
form, follow the link that offers to create an account. Once you're in you
can pin the language explicitly from the interface-language setting in
**Settings**, which is remembered per browser rather than per account.

Registration is closed by default, so the form asks for a token, in the
field for the bootstrap token. It's the `BOOTSTRAP_TOKEN` in your `.env`:

```bash
grep BOOTSTRAP_TOKEN .env
```

Copy the value after the `=` (the whole thing, including a trailing `=` if
there is one) and paste it into the form. The first account created this way
becomes the admin automatically.

Registration attempts are limited to **5 per 15 minutes per IP address**, so
that a short or hand-picked token can't be guessed by brute force. If you
mistype the token five times the form stops accepting attempts and tells you
to try again later, and you'll need to wait out the 15 minutes. Check the
value with the `grep` above rather than retrying.

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
npm run db:generate    # all three database clients, not just the one you configured
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
accepted.

**You don't pick a profile.** BudgetPilot reads the file's header row and works
out the format itself. These are the ones it knows:

| Format           | What it is                                |
| ---------------- | ----------------------------------------- |
| Banque Populaire | Their statement export                    |
| Revolut          | Their statement export, French or English |
| Home             | BudgetPilot's own CSV export              |
| Generic          | Any other CSV, matched by column name     |

If it recognises none of them, it asks you which column is which. See
[importing a statement](./using/imports.md) for that screen.

**Home** recognises three shapes: the seven-column header the oldest exports
wrote, the ten-column one that followed, and the eleven-column one exports
write today. A file you exported months ago still imports, unchanged: an older
shape is kept, never replaced.

The eleventh column is `compte`. It names the account each transaction came
from, so the file says where your transactions live and not only what they were.
It is filled in when everything in the export is from one account, and left
empty when the export mixes several, because naming the wrong account would be
worse than naming none.

The other extra columns exist so a **split transaction** survives the trip, one
payment recorded against several categories. See
[splitting a transaction](./using/split-transactions.md) for how to make one,
and the [split reference](./reference/split-transactions.md) for the exact
column meanings. The export writes one line per category the money went to,
and `montant_total`, `part` (`1/2`, `2/2`, …) and `categorie_parent` are what
put those lines back together as one transaction with its parts, rather than
as several separate transactions. Two limits worth knowing:

- Re-importing an export adds nothing **when those transactions came in
  through Home or Generic**. Every line is recognised as one you already have,
  so it is reported as a duplicate rather than imported twice.

  **It does add a second copy when they came in through Banque Populaire or
  Revolut.** Transactions belong to an account, and BudgetPilot never compares
  two transactions in two different accounts. That is on purpose: the same
  payment really can appear on two of your accounts. An export is read back as a
  Home file, and a Home file goes into your CSV account, so the copies land
  beside the originals instead of on top of them. The `compte` column records
  which account they came from, but the import does not read it back yet.

  You will be warned before it happens: the import screen spots that the file
  repeats an earlier import and asks you to confirm. If you confirm, you get both
  copies, and you can delete the new import from **Imports**.

  To move a statement between instances, or to keep a copy you can restore,
  use **Settings, Backup** rather than the CSV export. A backup restores your
  transactions exactly as they were, whichever format they arrived in.

- A part's **note** is not exported. Everything else about a split comes
  back exactly as it went out: its parts' categories, their amounts, their
  order, and the category the transaction returns to if you remove the
  split.

Your bank isn't listed? You usually don't have to do anything. BudgetPilot
matches columns by name, so most exports import as they are. This is the
shape it understands without help:

```csv
date,label,amount,category
2026-01-15,CARREFOUR MARKET,-42.30,Alimentation
2026-01-28,SALAIRE,2450.00,
```

- `date`, `label` and `amount` are required, `category` is optional and can
  be left empty.
- `category` is matched against the category name, and a name that matches
  nothing creates a new category. A category has one name, the one you see, so
  write in your file exactly what the Categories page shows. The 14 built-in
  categories are created under French names, which is what the sample above
  uses; if you accepted the offer to rename them into your own language, use
  the new names instead.
- **Extra columns are ignored, not refused.** A bank export with a balance
  and a reference column imports fine; BudgetPilot uses what it recognises.
- Column names are matched loosely: `Libellé`, `libelle`, and `Description`
  all fill the label. Accents and capitals don't matter.
- Dates can be `2026-01-15`, `15/01/2026`, `15.01.2026`, or `15-01-2026`. The
  day comes first, never the month.
- If nothing matches, BudgetPilot asks you to designate the columns rather
  than refusing the file.
- Amounts are signed: negative is an expense, positive is income. A zero
  amount is rejected.

Duplicates are detected per transaction, so re-importing an overlapping
statement creates only the rows that are new. The comparison uses the date,
the label, the amount and the direction: if you later re-read the same
statement through a different label or date column, those rows count as new,
and BudgetPilot asks before writing them. See
[duplicate detection](./reference/imports.md#duplicate-detection).

**Or enter transactions by hand** from the Transactions page, if you just
want to try it out.

**Tag a few of them.** A category answers "what kind of spending is this",
and every transaction has exactly one. A tag answers "what was this for",
and a transaction can carry any number. That is what lets "Portugal 2026"
hold a train, a hotel and a restaurant while each keeps its own category.

Open a transaction from the Transactions list, type a name in the tags
field, press Enter, then Save. Typing a name that doesn't exist yet creates
it, so there is no list to set up first. Once a tag exists you
can filter the list by it, and the filter bar can then tag everything
currently matching in one action. A tag left on no transactions disappears
on its own, with no confirmation and nothing to clean up.

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
and random. Generate it with one of the commands above rather than picking
one by hand. Registration is rate limited (5 attempts per 15 minutes per IP),
but that bounds guessing rather than preventing it, and it is no substitute
for a token with real entropy. Use three different values, never the same one
twice.

---

## Where to go next

- [Configuration](./configuration.md): every setting, and how to reach the
  app from your phone or another machine.
- [Reverse proxy](./reverse-proxy.md): a real domain with automatic HTTPS,
  via the optional Caddy overlay.
- [PostgreSQL or MySQL](./database-providers.md): only if you already run a
  database server. The install above uses SQLite and needs nothing.
- [Operations](./operations.md): updating, backups, moving to another
  machine.
- [Local AI advice](./ai-insights.md): the optional Ollama setup.
- [Bank sync](./bank-sync.md): the optional automatic PSD2 connection.
- [Troubleshooting](./troubleshooting.md): when something's broken.
