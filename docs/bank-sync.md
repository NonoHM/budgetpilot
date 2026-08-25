# Set up automatic bank sync

Bank sync pulls transactions straight from your bank over PSD2, using
[Enable Banking](https://enablebanking.com/) as the licensed provider. You
authorize the connection on your bank's own website, and BudgetPilot only ever
holds a consent token. There's no credential scraping and no password sharing.

This is the advanced path. It needs a provider account, a registered
application, a keypair you generate yourself, HTTPS, and an activation step on
the provider's side. Budget an hour the first time.

## Who should skip this

Most people. BudgetPilot is fully usable without bank sync, in manual and CSV
mode, and it's off by default. While it's off, the app makes no network call to
any bank or provider.

Skip this page if you want to try BudgetPilot first, if you don't have a domain
or a way to serve HTTPS, or if your bank isn't covered by Enable Banking.

## How much this has been tested

Once, by one person, against one bank, in production. That's the whole sample,
and you should know it before you trust a step below.

Nothing in the automated test suite exercises the live path, and that's
structural rather than an oversight:

- `e2e/bank-connections-page.spec.ts` covers the page layout only. Its own
  header explains that there's no end-to-end-safe way to reach the provider,
  because the route exposes the real connector and never the mock one.
- `src/lib/server/banking/enablebanking/enablebanking.sandbox-validation.ts`
  does make real calls, but you opt into it by hand, it runs under a separate
  config, it never runs in CI, and it points at the sandbox rather than
  production.
- Every other bank sync test uses a fake connector.

So treat this page as a transcript of one successful setup. Where a step says
something was measured, it was measured once. If your bank, your country, or
your provider plan behaves differently, that's entirely possible, and this page
is the thing that's wrong.

## What you need before you start

- An [Enable Banking](https://enablebanking.com/) account.
- A way to serve your instance over HTTPS. Step 1 covers this.
- `openssl`, to generate a keypair.
- Shell access to the machine running BudgetPilot.

## Step 1: Put HTTPS in front of your instance

Enable Banking's Control Panel rejects an `http://` redirect URL when you
register an application, with the message "uses unsupported scheme". BudgetPilot
speaks plain HTTP only, so something else has to terminate TLS in front of it.

Use the reverse proxy that ships with this repository. For the full setup, see
[reverse-proxy.md](reverse-proxy.md).

**If you have a domain:**

1. Copy `Caddyfile.example` to `Caddyfile`.
2. Replace the placeholder domain with yours.
3. Start the stack with `docker-compose.proxy.yml` added to your compose
   command.

Caddy requests a Let's Encrypt certificate on its own. Ports 80 and 443 need to
be reachable from the internet for that to work.

**If you don't have a domain:**

1. Uncomment `tls internal` in your `Caddyfile`.
2. Start the stack the same way.

Caddy then issues a certificate from its own local authority, so HTTPS works on
a local name with no domain and no public DNS.

The catch: nothing trusts that authority, so your browser warns you on the first
visit and you have to click through. That includes the moment your bank sends
you back mid-consent, which is a security warning at the worst possible time. It
works for yourself. Don't hand it to anyone else.

**To verify:** open your instance in a browser over `https://`. You should reach
the login page, with a padlock or a warning you can click through, and not a
connection error.

**If you skip this step:** you can't register an application at all. The
registration form rejects your redirect URL, and you never receive an
application ID.

### Why an accepted URL still isn't enough

The registration form does accept `https://localhost:3000`. Accepting a URL and
being able to reach it are different things.

If you register an `https://` URL on a port where nothing terminates TLS, the
flow dies after you've authorized at your bank and after the bank has issued the
authorization code. Your browser hits a port that doesn't answer a TLS
handshake. Measured against a running instance: a TLS client against port 3000
gets `wrong version number` and no certificate, and `curl` gives up with exit 35.

The registration is fine in that case. The callback is unreachable. Nothing
appears in the app's logs, because nothing reached the app.

We've only tested production. A sandbox application might well be more
permissive about plain HTTP, and third-party write-ups say it is, but Enable
Banking documents nothing either way. Treat HTTPS as required in both until you
see otherwise on your own account.

## Step 2: Choose one origin

This is the step that costs the most time, because three settings look
independent and aren't. Decide your origin once, then use the same string in all
three places, character for character:

| Where                                | Value                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| `ORIGIN` in `.env`                   | `https://your.domain`                                   |
| `BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` | `https://your.domain`                                   |
| Control Panel, Redirect URLs         | `https://your.domain/imports/bank-connections/callback` |

The callback path is fixed and never configurable. Only the origin is yours to
choose.

**Write the origin the way a browser would.** Behind a proxy on port 443, the
origin carries no port, because 443 is the default for `https`.
`https://localhost:3000` and `https://localhost` are different origins even when
the same instance answers both, and the first one looks perfectly reasonable
while you're typing it into a registration form. That exact mistake is what
prompted this page: registering
`https://localhost:3000/imports/bank-connections/callback` while Caddy served
`https://localhost` on 443 killed the flow.

Set the two variables in `.env` now. You'll paste the third into the Control
Panel in step 4.

```dotenv
ORIGIN=https://your.domain
BANK_SYNC_REDIRECT_ALLOWED_ORIGINS=https://your.domain
```

**If you skip this step:** the three mismatches fail in three different ways,
and only one of them tells you which setting is wrong.

| What's wrong                         | What you see                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `ORIGIN`                             | Every form submission returns HTTP 403, `Cross-site POST form submissions are forbidden` |
| `BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` | "The return URL is not allowed (BANK_SYNC_REDIRECT_ALLOWED_ORIGINS)"                     |
| The URL registered in Control Panel  | "Invalid operation." and nothing else                                                    |

A wrong `ORIGIN` blocks the **Connect** button itself, so the consent flow never
starts. You never leave BudgetPilot and no bank page opens. A 403 on a form
submission reads like a login, session, or cookie problem, which is why it's
worth ruling out first. Measured: with the browser on `https://localhost:8443`
and `ORIGIN` left at `http://localhost:3000`, the request is refused. Setting
`ORIGIN=https://localhost:8443` on the same container makes the identical
request return 200.

A wrong registered URL is the quiet one. The provider rejects the authorization
request, and the app shows only "Invalid operation." (message key
`bank_connections_error_generic`). There's no log line, no variable name, and no
mention of a redirect URL. The provider's error isn't a `BankSyncError`, so it
falls through to the generic branch in
`src/routes/imports/bank-connections/+page.server.ts`.

Note that the compose files default `ORIGIN` to
`http://localhost:${APP_PORT:-3000}`. As soon as you serve HTTPS, that default
is wrong, so always set `ORIGIN` explicitly here.

## Step 3: Create your private key and certificate

The certificate goes to the Control Panel. The private key stays on your machine
and never leaves it.

1. Create a directory for the keypair and generate the key:

   ```bash
   mkdir -p keys
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out keys/enablebanking.pem
   ```

2. Generate a self-signed certificate from that key:

   ```bash
   openssl req -new -x509 -days 365 -key keys/enablebanking.pem \
     -out keys/enablebanking.crt -subj "/CN=budgetpilot"
   ```

3. Note the expiry date and write it down somewhere you'll see it again:

   ```bash
   openssl x509 -in keys/enablebanking.crt -noout -enddate
   ```

`keys/` and `*.pem` are already in `.gitignore`. Keep it that way.

**To verify:** `ls keys/` shows `enablebanking.pem` and `enablebanking.crt`.

### About the key size

Enable Banking's own form prints `openssl genrsa -out private.key 4096`, and
their documentation states no minimum or required length anywhere. The 4096
above matches the size they show, which is the safe choice when the requirement
is unstated.

A 2048-bit key has since been measured working end to end against a production
application: accepted by the registration form, and its signed tokens accepted
by the production API. That's one observation on one account, not a published
guarantee. If it matters to you, ask support.api@enablebanking.com rather than
trusting either number.

## Step 4: Register the application

1. Sign in to the Enable Banking Control Panel and open the API applications
   page.
2. Select the **Production** environment.
3. Enter your application name, description, data protection email, privacy
   policy URL, and terms of service URL. The description is shown to you during
   consent, so make it recognizable.
4. In **Redirect URLs**, paste your callback URL from step 2:

   ```
   https://your.domain/imports/bank-connections/callback
   ```

5. In the field labelled **Public certificate in PEM format**, paste the entire
   contents of `keys/enablebanking.crt`, including the
   `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines.
6. Submit the form.

A bare public key is not a certificate. If you ran `openssl rsa -pubout` and
have a `.pub` file, that's the wrong file for this field. Paste the `.crt`.

**To verify:** the application appears in the Control Panel with a UUID. That
UUID is your `ENABLE_BANKING_APP_ID`. Copy it into `.env`:

```dotenv
ENABLE_BANKING_APP_ID=<the UUID from the Control Panel>
```

**If you skip this step:** there's nothing to configure, and no half-finished
state to get stuck in.

## Step 5: Activate the application

**A production application isn't active when you register it.** It's created
`Inactive`, and until you change that, every API call returns HTTP 403 with the
body `{"code": 403, "message": "Application is not active"}`. That includes the
call that fetches the list of banks, so you can't even choose a bank.

You have two ways to activate it, and the Control Panel offers both as buttons
on the application.

**Option A, link your own accounts.** This is the route for a personal,
self-hosted instance, and almost certainly the one you want.

1. On the application, select **Activate by linking accounts**.
2. Follow the authorization flow through to your bank and confirm.
3. Return to the Control Panel.

The application flips to `Active`, and its services are badged **Account
Information Restricted**. In this mode, per Enable Banking's documentation, "you
can only fetch data from accounts linked to the application". Once the
application is active, the same button reads **Link accounts** and adds more.

**Option B, request unrestricted activation.** This is the route for an
organization. The button reads **Request activation**, or **Request
Unrestriction** if you're already active in restricted mode. Enable Banking
describes it as a manual review by their staff, who "check the application name
and description, as well as its privacy policy and terms of service, verify your
contract and completion of 'Know-Your-Customer' process, and associate it with
your billing account". Their documentation gives no timeline, and states
elsewhere that the application "will stay in this state until an agreement has
been signed".

**To verify:** the application header in the Control Panel reads `Active`, and
your bank appears under **Linked accounts**. A working setup looks like this:

```
budgetpilot (c2c4eb28-...)   Active
Environment: PRODUCTION
Services: Account Information Restricted
Redirect URLs: https://your.domain/imports/bank-connections/callback
Linked accounts: Your Bank (France): IBAN ...
```

**If you skip this step:** the **Bank connections** page shows "The bank list is
unavailable right now. Try again later." (message key
`bank_connections_banks_unavailable`), you can't select a bank, nothing is
written to the logs, and no amount of retrying changes anything, because the
condition is on the provider's side and is waiting for you.

**Plan for this consequence:** in restricted mode, an account you haven't linked
in the Control Panel can't be read, whatever you authorize inside BudgetPilot.
If a bank account you expect is missing from a connection, check the linked list
there before looking at anything in this app.

Sources for this step: Enable Banking's
[Control Panel guide](https://enablebanking.com/docs/api/control-panel/) and
[Whitelisting own accounts for restricted API usage](https://enablebanking.com/docs/api/linked-accounts/).

## Step 6: Give the container your private key

`ENABLE_BANKING_PRIVATE_KEY_PATH` is resolved inside the container, and none of
the base compose files mount your `keys/` directory. Choose one of two ways to
get the key in.

**Option A, mount the directory.** This repository ships an overlay for exactly
this.

1. Set the path in `.env`:

   ```dotenv
   ENABLE_BANKING_PRIVATE_KEY_PATH=./keys/enablebanking.pem
   ```

2. Add `docker-compose.keys.yml` to your compose command:

   ```bash
   docker compose -f docker-compose.prebuilt.yml -f docker-compose.proxy.yml \
     -f docker-compose.keys.yml up -d
   ```

The overlay mounts `./keys` read-only at `/app/keys`. The container's working
directory is `/app`, so the relative path above resolves to
`/app/keys/enablebanking.pem`.

This works alongside `read_only: true`, which the base compose files set on the
app. That flag restricts writes, and BudgetPilot only ever reads this file. The
mount is read-only as well, so a compromised container can't rewrite the key it
signs with.

**Option B, pass the key inline.** Set `ENABLE_BANKING_PRIVATE_KEY` to the PEM
contents with newlines written as `\n`, and leave
`ENABLE_BANKING_PRIVATE_KEY_PATH` empty. Nothing is mounted and nothing lands on
the container filesystem, which suits a deployment that injects environment
variables from a secret manager.

The cost of option B: your key sits in the container's environment, so anyone
who can run `docker inspect` or read your `.env` can read the key. Weigh that
against a file with tight permissions.

Setting both variables is a deliberate startup error, so that a stale copy of
one can't silently mask the other.

**If you skip this step:** the app throws
`Enable Banking private key file not found (ENABLE_BANKING_PRIVATE_KEY_PATH); tried: ...`
internally, and you never see it. The bank list reports itself unavailable,
actions report "Invalid operation.", and nothing is written to the logs. The
error naming the exact paths it tried is built and then discarded.

## Step 7: Confirm the container can read the key

Skip this step and you'll debug it later. If you chose option B in step 6, move
on to step 8.

**Permissions are decided inside the container, and a host directory listing
can't answer the question.** The app runs as uid **65532**, from the distroless
base image. Your key file belongs to your own user, which is almost certainly a
different number, and ownership crosses a bind mount by number rather than by
name.

1. Give the file to uid 65532 and tighten its mode:

   ```bash
   sudo chown 65532 keys/enablebanking.pem
   chmod 600 keys/enablebanking.pem
   ```

2. Restart the stack so the mount is in place.

3. Ask the container whether it can open the file. The image is distroless, with
   no shell, no `ls`, and no `cat`, so use the Node binary that's already in it:

   ```bash
   docker compose exec -T budgetpilot /nodejs/bin/node -e '
   const fs = require("node:fs");
   const f = "/app/keys/enablebanking.pem";
   try {
     const st = fs.statSync(f);
     console.log("uid=" + process.getuid() + " mode=" + (st.mode & 0o777).toString(8) +
                 " owner=" + st.uid + " bytes=" + fs.readFileSync(f).length);
   } catch (e) { console.log("FAILED: " + e.code + " " + e.message); }
   '
   ```

**To verify:** the command prints a line ending in a byte count, such as
`bytes=1704`. That means the container opened and read the key.

Read any other result as follows:

| Output           | What it means                                                 |
| ---------------- | ------------------------------------------------------------- |
| `bytes=<number>` | Success. Continue to step 8.                                  |
| `FAILED: ENOENT` | The mount is missing or the path is wrong. Go back to step 6. |
| `FAILED: EACCES` | The file is there and uid 65532 can't open it. Redo action 1. |

`chmod 600` plus ownership by uid 65532 is the tightest combination that works:
only the container's user can read it, and on the host it's readable only by
root.

**If you skip this step:** you get the same silence as step 6. The permission
error is thrown, caught, and discarded, and every screen tells you to try again
later.

## Step 8: Turn bank sync on

Set the flag in `.env`:

```dotenv
BANK_SYNC_ENABLED=true
```

Then restart the stack.

**To verify:** open **Imports > Bank connections**. You should see a connect
form rather than a notice saying the feature is disabled.

**If you skip this step:** the page says so plainly, "Bank sync is disabled on
this instance (BANK_SYNC_ENABLED)" (message key
`bank_connections_disabled_notice`), and no network call is made. This is the
one setting whose absence is stated on screen.

## Step 9: Connect your bank

1. Go to **Imports > Bank connections**.
2. Choose your country, then your bank.
3. Select **Connect**.
4. Complete the consent flow on your bank's website.

You return to BudgetPilot with a live connection.

**To verify:** the connection card appears with status `Active` and an account
count.

Each detected account becomes an import bucket. You can link a bucket to a net
worth account, and from then on each sync also records the real balance as a
snapshot.

## What happens after you connect

- **Syncs are throttled to one every 6 hours** per connection. PSD2 gives you a
  limited budget of unattended calls per day, so the button is disabled rather
  than letting you burn through it.
- **Consent expires**, typically after 90 days, and your bank decides when. The
  connection card shows "expires soon" 14 days ahead and offers a renewal that
  reuses the same bank without losing your imported history.
- **The first sync backfills 90 days.** After that, each sync re-fetches the
  last 7 days on top of the new ones, and duplicate detection absorbs the
  overlap.
- **Deleting a connection keeps the transactions it already imported.** They're
  yours, and they stay.

## Renew the certificate before it expires

Your certificate expires, and nothing warns you. `-days 365` in step 3 means one
year from the day you ran it.

BudgetPilot never reads the certificate. It only signs tokens with the private
key, so no screen in the app can tell you the date is approaching, and Enable
Banking documents no expiry or rotation policy at all.

To renew:

1. Generate a fresh certificate from the **same** private key:

   ```bash
   openssl req -new -x509 -days 365 -key keys/enablebanking.pem \
     -out keys/enablebanking.crt -subj "/CN=budgetpilot"
   ```

2. Upload it in the Control Panel in place of the old one.

The key never changes, so your configuration and your existing connections are
untouched.

Enable Banking's documentation describes no way to replace a certificate on a
registered application. If the Control Panel offers no edit field, registering a
new application, with a new `ENABLE_BANKING_APP_ID`, is the fallback. You can
also push the deadline further out at creation time with a larger `-days` value,
such as `-days 3650`. That's untested against their form rather than known to
work.

## Troubleshooting

**Read this before you go looking in the logs.** The app tells you very little
about this path, and knowing that saves you an afternoon.

Every failure in the connect path, whether it's the bank list, the **Connect**
button, or the callback, reports as one of two short generic messages and writes
**nothing** to the logs. The banking module contains exactly one `console.warn`
across its 13 files, and it fires on the balance sub-fetch of a sync that's
already working. An empty `docker compose logs` is the normal state during a
broken setup. It isn't evidence that nothing went wrong.

So diagnose from the outside in:

| Symptom                                                              | Check, in this order                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "The bank list is unavailable right now. Try again later."           | The Control Panel says `Active` (step 5). Then the key probe (step 7). Then the app ID. |
| "Invalid operation." when you select **Connect**                     | The registered redirect URL against your origin, character by character (step 2).       |
| HTTP 403, `Cross-site POST form submissions are forbidden`           | `ORIGIN` (step 2).                                                                      |
| "The return URL is not allowed (BANK_SYNC_REDIRECT_ALLOWED_ORIGINS)" | `BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` (step 2).                                          |
| A browser connection error after you authorize at the bank           | TLS isn't actually served on the registered URL (step 1).                               |
| An account is missing from a working connection                      | It isn't in the Control Panel's linked accounts (step 5).                               |

Quoted messages above come from the English catalogue. If your instance runs in
another language, match on the message key named beside each one earlier in this
page rather than on the text.

### Diagnosing a connection that already exists

For a connection that's already established and fails on sync, there's one real
diagnostic, and it isn't in the logs either. The `BankConnection` row keeps a
sanitized `lastSyncError`, of the form `http_403`. It's deliberately kept
server-side and never rendered, so reading it means querying the database
directly.

The status is the useful part. `401` and `403` point at credentials or
activation, `429` at the provider's rate limit, and consent expiry surfaces on
the connection card by itself.

The format allows a `:PROVIDER_CODE` suffix, but in practice it stays empty
against Enable Banking. The reader requires the response's `code` field to be a
string, and this provider sends a number, so the code is dropped. Expect the
bare status.

### What you can't get, on purpose

The provider's own error text never reaches you, anywhere. Response bodies can
carry account identifiers, so the HTTP client keeps the status and a
machine-readable code and discards the rest.

That's the intended trade. It also means the Control Panel, not this app, is the
authority on why the provider refused something.

## Settings reference

Every variable below is documented in full in `.env.example`, which is the
authoritative reference. This is the short version.

| Variable                             | Purpose                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `BANK_SYNC_ENABLED`                  | Master switch. Anything but `true` disables the feature entirely.        |
| `ENABLE_BANKING_APP_ID`              | The application UUID from the Control Panel.                             |
| `ENABLE_BANKING_PRIVATE_KEY_PATH`    | Path to the PEM file, resolved inside the container.                     |
| `ENABLE_BANKING_PRIVATE_KEY`         | The PEM inline instead, newlines as `\n`. Mutually exclusive with above. |
| `ORIGIN`                             | Your instance's origin. Must match the other two places in step 2.       |
| `BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` | Allowlist for the consent callback. Unset means no flow can start.       |
| `BANK_SYNC_ALLOWED_HOSTS`            | Provider API allowlist. Defaults to `api.enablebanking.com`, HTTPS only. |
| `ENABLE_BANKING_BASE_URL`            | Provider API base URL. Always re-validated against the allowlist.        |
| `BANK_SYNC_FIRST_LOOKBACK_DAYS`      | Catch-up window for a connection's first sync. Defaults to 90.           |
