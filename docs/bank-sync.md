# Automatic bank sync (optional, advanced)

BudgetPilot can pull transactions straight from your bank over PSD2, through
[Enable Banking](https://enablebanking.com/) as the licensed provider. No
credential scraping: you authorize the connection on your bank's own site,
and the app only ever holds a consent token.

**This is the advanced path.** It needs a provider account, an application
registered on their side, and a keypair you generate yourself. The app is
100% usable without it, in manual and CSV mode, which is what most people
should do. It's off by default and makes no network call while off.

## What you need before starting

1. An [Enable Banking](https://enablebanking.com/) account and an
   application created in their Control Panel. Their sandbox is free and
   works against a mock bank, which is the sane way to try this.
2. An RSA private key and a self-signed certificate, generated locally. The
   certificate gets uploaded to the Control Panel, the private key stays on
   your machine and never leaves it:

   ```bash
   mkdir -p keys
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out keys/enablebanking.pem
   openssl req -new -x509 -days 365 -key keys/enablebanking.pem \
     -out keys/enablebanking.crt -subj "/CN=budgetpilot"
   ```

   The registration form's last field is labelled **"Public certificate in
   PEM format"**. Paste the whole of `keys/enablebanking.crt`, including the
   `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines. A
   bare public key (`openssl rsa -pubout`) is not a certificate and is not
   what that field is asking for.

   `keys/` and `*.pem` are gitignored. Keep it that way.

   **On the key size.** Enable Banking's own form prints
   `openssl genrsa -out private.key 4096`, but their documentation states no
   minimum or required length anywhere. Not in the
   [API reference](https://enablebanking.com/docs/api/reference/), the
   [quick start](https://enablebanking.com/docs/api/quick-start/) or the
   [Control Panel guide](https://enablebanking.com/docs/api/control-panel/).
   4096 above matches the size they show, which is the safe choice when the
   requirement is unstated. 2048 (what this page used to print) may well work
   too, but nothing published says so. If it matters to you, ask
   support.api@enablebanking.com rather than trusting either number.

   **This certificate expires, and nothing will warn you.** `-days 365`
   means one year from the day you run it. BudgetPilot never reads the
   certificate. It only signs JWTs with the private key, so no screen in the
   app can tell you the date is approaching, and Enable Banking documents no
   expiry or rotation policy at all. Check the date now and write it down:

   ```bash
   openssl x509 -in keys/enablebanking.crt -noout -enddate
   ```

   To renew, generate a fresh certificate from the _same_ private key (the
   `req -new -x509` line again) and upload it to the Control Panel in place
   of the old one. The key never changes, so
   `ENABLE_BANKING_PRIVATE_KEY_PATH` and your existing connections are
   untouched. Their docs describe no way to replace the certificate on a
   registered application, so if the Control Panel offers no edit field,
   registering a new application (new `ENABLE_BANKING_APP_ID`) is the
   fallback. You can also push the cliff further out at creation time with a
   larger `-days` value, e.g. `-days 3650`. The certificate is self-signed
   and Enable Banking publishes no maximum validity, so this is untested
   against their form rather than known-good.

3. The redirect URL registered in the Control Panel, matching **exactly**
   what your instance serves. It has to be `https://`:

   ```
   https://your.domain/imports/bank-connections/callback
   ```

   The path is fixed and never configurable. The origin must be the same one
   you put in `ORIGIN`. A mismatch here means the consent flow dies on the
   way back from your bank.

## HTTPS is required before any of this works

Read this before you register an application, not after.

**The Control Panel refuses an `http://` redirect URL.** Pasting
`http://localhost:3000/imports/bank-connections/callback` into the
registration form fails with "uses unsupported scheme". This is Enable
Banking's rule, not ours, and it is enforced by their form at registration
time. Their published documentation does not state the rule anywhere: not in
the [API reference](https://enablebanking.com/docs/api/reference/), the
[quick start](https://enablebanking.com/docs/api/quick-start/), the
[Control Panel guide](https://enablebanking.com/docs/api/control-panel/) or
the [FAQ](https://enablebanking.com/docs/faq/). The refusal message is the
only statement of it we have. Earlier versions of this page printed an
`http://localhost:3000` example, which could never have been registered by
anyone who followed it.

**`https://localhost:3000` is accepted by the form.** That was measured
against a Production application, not read in their docs. It does not mean
you are finished, because accepting the URL and being able to use it are two
different things.

**Your instance then has to actually serve TLS on that address.** The bank
sends the browser to whatever you registered. BudgetPilot itself speaks plain
HTTP only, so if you register `https://localhost:3000` and nothing terminates
TLS on port 3000, the browser hits a port that does not answer a TLS
handshake. The flow dies right there, after you have authorized at your bank
and after the bank has issued the authorization code, with a connection error
in the browser and nothing in the app's logs. Verified against a running
instance: a TLS client against port 3000 gets `wrong version number` and no
certificate, and `curl` gives up with exit 35. The registration is fine. The
callback is simply unreachable.

Put a TLS reverse proxy in front and the same callback works. Also verified:
with Caddy terminating TLS and proxying to the container, a `GET` on
`/imports/bank-connections/callback?code=...` reaches the route and is
handled normally.

**We do not know whether the sandbox is more permissive.** It would be
reasonable for a sandbox application to accept plain HTTP, and third-party
write-ups say it does, but Enable Banking documents nothing either way and we
have only tested Production. Treat HTTPS as required in both until you have
seen otherwise with your own account.

### What to actually do

Use the reverse proxy that ships with the repo. See
[reverse-proxy.md](reverse-proxy.md).

- **You have a domain.** Copy `Caddyfile.example` to `Caddyfile`, put your
  domain in it, and start the stack with `docker-compose.proxy.yml`. Caddy
  gets a Let's Encrypt certificate on its own. Register
  `https://your.domain/imports/bank-connections/callback`.
- **You do not have a domain.** Uncomment `tls internal` in the `Caddyfile`.
  Caddy issues the certificate from its own local authority, so HTTPS works on
  a local name with no domain and no public DNS. The catch is that nothing
  trusts that authority, so the browser warns on first visit and you have to
  click through. That includes the moment the bank sends you back, which is a
  security warning in the middle of a consent flow. It works, but it is not
  something to hand to anyone else.

Whichever you pick, the registered redirect URL, `ORIGIN` and
`BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` must all be the same origin, protocol
and port included.

### ORIGIN has to change with it

The compose files default `ORIGIN` to `http://localhost:${APP_PORT:-3000}`.
The moment you serve HTTPS, that default is wrong and it fails loudly.

Verified against a running instance: with the browser on
`https://localhost:8443` and `ORIGIN` left at `http://localhost:3000`, every
form submission is refused with `Cross-site POST form submissions are
forbidden` and HTTP 403. Setting `ORIGIN=https://localhost:8443` on the same
container makes the identical request return 200.

That 403 hits the **Connect** button too, so with a stale `ORIGIN` the consent
flow cannot even start. **The failure is before the bank, not after it.** You
never leave BudgetPilot, no bank page ever opens, and the redirect URL you
carefully registered is never reached. This is the part that wastes an
afternoon: you set up the proxy, you fixed the scheme, bank sync now looks
broken in a way that has nothing to do with banks. A 403 on a form submission
reads like a login problem, a session problem or a cookie problem. It is
`ORIGIN`.

`BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` fails in the same place for the same
reason. It is checked when the flow starts, so a stale `http://localhost:3000`
there also stops you before the bank rather than after it. The one mercy is
that it names itself: the page shows "The return URL is not allowed
(BANK_SYNC_REDIRECT_ALLOWED_ORIGINS)". The `ORIGIN` 403 gives you no such
hint, which is why it is worth checking first.

Set all three together:

```dotenv
ORIGIN=https://your.domain
BANK_SYNC_REDIRECT_ALLOWED_ORIGINS=https://your.domain
```

and register `https://your.domain/imports/bank-connections/callback` in the
Control Panel.

## Configuration

```dotenv
BANK_SYNC_ENABLED=true
ENABLE_BANKING_APP_ID=<the application id from the Control Panel>
ENABLE_BANKING_PRIVATE_KEY_PATH=./keys/enablebanking.pem
BANK_SYNC_REDIRECT_ALLOWED_ORIGINS=https://your.domain
```

Notes that will save you time:

- The private key can be given as a file path
  (`ENABLE_BANKING_PRIVATE_KEY_PATH`) **or** inline
  (`ENABLE_BANKING_PRIVATE_KEY`, newlines written as `\n`). Setting both is
  a startup error, on purpose.
- In Docker, a path has to be readable _inside_ the container. Mount the
  `keys/` folder as a volume, or use the inline form.
- `BANK_SYNC_REDIRECT_ALLOWED_ORIGINS` is fail-safe: leave it unset and no
  connection flow can start at all. It takes full origins, comma-separated,
  no trailing slash.
- `BANK_SYNC_ALLOWED_HOSTS` defaults to `api.enablebanking.com` and only
  ever allows HTTPS. Unlike the AI allowlist, there's no plain-HTTP
  exception anywhere in the banking path.

## Using it

**Imports > Bank connections**, then pick your bank and follow the consent
flow on their site. You come back to BudgetPilot with a live connection.

Each detected account becomes an import bucket. You can link a bucket to a
net worth account, and from then on each sync also records the real balance
as a snapshot.

Two behaviors worth knowing about:

- **Syncs are throttled to one every 6 hours** per connection. PSD2 gives
  you a limited budget of unattended calls per day, so the button is
  disabled rather than letting you burn through it.
- **Consent expires**, typically after 90 days, and it's the bank that
  decides. The connection card shows "expires soon" 14 days ahead and offers
  a renewal that reuses the same bank without losing your imported history.

The first sync backfills 90 days. After that each sync re-fetches the last 7
days on top of the new ones, and duplicate detection absorbs the overlap.

## When it breaks

Connection errors show up as a short generic message on the connection card,
never the provider's raw response, which can carry account identifiers. The
sanitized detail is in the logs:

```bash
docker compose logs budgetpilot | grep -i sync
```

Common causes, in order of likelihood: consent expired (renew it), the
redirect URL in the Control Panel not matching `ORIGIN` character for
character, or a missing/unreadable private key.

Deleting a connection keeps the transactions it already imported. They're
yours, they stay.
