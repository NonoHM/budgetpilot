# Reverse proxy and HTTPS (optional)

BudgetPilot serves plain HTTP. That's fine on `localhost`, and fine on a LAN
you trust with `PUBLIC_INSTANCE=false`. The moment the app is reachable from
anywhere else, you want a certificate in front of it.

This page covers the bundled option: an optional
[Caddy](https://caddyserver.com/) overlay that obtains and renews a Let's
Encrypt certificate on its own. Nothing here is required. If you only ever
open the app on the machine running it, skip this page entirely.

## What you need first

- A domain name pointed at the machine, with an `A` (or `AAAA`) record.
  Caddy checks this by asking Let's Encrypt to reach you, so a hosts-file
  entry or a private DNS name will not do.
- Ports 80 and 443 open to the Internet on that machine. Both: 80 is used
  for the certificate challenge and to redirect to HTTPS, 443 serves the
  app.
- Nothing else already listening on those ports.
- Docker Compose 2.24 or newer (`docker compose version`). The overlay uses
  the `!reset` tag to unpublish the app's own port, and older Compose
  versions don't understand it. This is the one page with that requirement;
  everything else works on any Compose v2.

No domain, and you only want to see the proxy working on your own network?
Use `tls internal` instead, described at the end of step 1. It skips Let's
Encrypt entirely, so the first two requirements drop away. The last two still
hold: ports 80 and 443 must be free on the machine, and Compose must be 2.24
or newer.

## Setup

### 1. Write your Caddyfile

```bash
cp Caddyfile.example Caddyfile
```

Open it and replace `budget.example.com` on the first uncommented line with
your domain. That's the only edit needed, and it is not optional: the name on
that line is the one Caddy asks Let's Encrypt to certify. `Caddyfile` is
gitignored, `Caddyfile.example` is the tracked template.

**If you leave `budget.example.com` in place, the stack starts and the site
never loads.** Nobody controls that domain, so validation can't succeed and
Caddy never gets a certificate. The failure is quiet in three separate ways,
which is why it's worth spelling out:

- The container stays up. Nothing crashes and nothing exits.
- The log shows `obtaining certificate` for `budget.example.com`, then
  `could not get certificate from issuer`, retried in the background forever.
- The browser shows no certificate warning, because there is no certificate
  to warn about. The TLS handshake fails outright. Chrome and Firefox say the
  site can't provide a secure connection, and `curl` reports
  `tlsv1 alert internal error`.

#### Testing without a domain

Uncomment the `tls internal` line in the site block. Caddy then issues the
certificate from its own local authority rather than asking Let's Encrypt, so
HTTPS works on a LAN name or an IP address that no public authority could
validate. Put that same name on the site address line, and set `ORIGIN` in
`.env` to the matching `https://` URL.

Every browser warns on the first visit, because nothing trusts that
authority. That's fine while you're testing on your own network. Don't use it
on an instance reachable from the Internet: the only thing left between a
visitor and an impostor is a warning you've taught them to click through.

### 2. Point `.env` at the new URL

```dotenv
ORIGIN=https://budget.example.com
```

`ORIGIN` has to match exactly what you type in the browser, protocol
included, or every form returns a 403.

If your `.env` still carries `PUBLIC_INSTANCE=false` from a LAN setup,
remove that line. Secure cookies are the default, and they're what you want
behind TLS.

### 3. Start the stack with the overlay

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

Published image instead:

```bash
docker compose -f docker-compose.prebuilt.yml -f docker-compose.proxy.yml up -d
```

The overlay also stops publishing the app's own port on the host, so Caddy
becomes the only way in. Reaching the container directly on `APP_PORT` no
longer works, which is the point. It sets `ADDRESS_HEADER=X-Forwarded-For`
and `XFF_DEPTH=1` at the same time, so the app still sees each visitor's real
address and the per-IP rate limits keep working instead of counting everyone
as one client.

Those two go together and neither is optional: the app only trusts
`X-Forwarded-For` because Caddy is the sole way in. If the port were still
published, anyone reaching it could forge that header, hand themselves a
fresh address on every request, and walk straight through the rate limits on
login, MFA, registration and bank-sync consent. Which is why the next step
is worth the ten seconds.

The AI overlay stacks on top if you use it, any order:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml -f docker-compose.proxy.yml up -d --build
```

Same stack on the prebuilt base:

```bash
docker compose -f docker-compose.prebuilt.yml -f docker-compose.ai.yml -f docker-compose.proxy.yml up -d
```

### 4. Check the app's own port is really closed

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml ps
```

The `budgetpilot` line must show **no** host port — only `3000/tcp`, with no
`0.0.0.0:...->` arrow in front of it. Only `caddy` publishes anything: 80,
443, and 443/udp for HTTP/3. If you see the app publishing a port, stop the
stack: your Compose is older than 2.24 and silently ignored the overlay's
`!reset`. Upgrade Compose and start again.

### 5. Check the certificate

```bash
docker compose -f docker-compose.yml -f docker-compose.proxy.yml logs caddy
```

The first start takes a few seconds while Caddy talks to Let's Encrypt. A
line mentioning `certificate obtained successfully` means you're done. Open
`https://budget.example.com`. With `tls internal` the same line appears, with
`"issuer":"local"` on it, and it arrives immediately because nothing leaves
the machine.

Certificates renew automatically, well before expiry. There's no cron job to
add and nothing to remember.

## What the Caddyfile does

Two things, both worth knowing about.

**It proxies to the app over the internal Compose network**, at
`budgetpilot:3000`. Port 3000 is the container's own port, which never
changes: `APP_PORT` only affects host publishing and is unused here.

**It strips secrets from its access log.** The bank sync consent callback
carries an OAuth-style one-time `code` in its query string. Access logs tend
to be world-readable, shipped to a log collector, or kept far longer than
that code stays valid, so `code` and `state` are deleted from every logged
URL. `q` is deleted too: it's the `/transactions` search term, so it holds
whatever merchant, amount or note the user typed to find their own
transactions, and the access log is the one place in this stack that would
keep that in plaintext outside the database. It used to matter for a second
reason — the link from a detected stream on `/upcoming-bills` to its
transactions filled `q` with a raw bank label off the user's statement, with
them typing nothing — but that link now uses opaque transaction ids. The
filter still covers everything
typed into the search box. If you write your own Caddyfile rather than
starting from the example, keep it.

## If it doesn't work

**The caddy container won't start, and Docker complains about mounting a
directory onto a file.** The full message ends with `Are you trying to mount a
directory onto a file (or vice-versa)?` and names the `Caddyfile` path. You
skipped step 1. With no `Caddyfile` in the folder, Docker creates an empty
_directory_ under that name, and the caddy image already ships a file there.
Remove the directory, run the `cp` from step 1, and start again.

**Caddy can't get a certificate**, logging `could not get certificate from
issuer` on repeat. First check you actually replaced `budget.example.com` in
the `Caddyfile`, which is step 1 and the most common cause. After that it's
almost always DNS or ports. Check the domain resolves to this machine from
the outside, not just from your own network, and that ports 80 and 443 reach
it. A firewall or an ISP blocking port 80 is the usual culprit.

**The app loads but every form fails with a 403.** `ORIGIN` doesn't match.
It must be `https://your.domain`, with no trailing slash and no port.

**Login bounces back to the login page.** That's the `Secure` cookie being
rejected, which means the browser isn't actually on HTTPS. Check the address
bar really says `https://`, and that `PUBLIC_INSTANCE=false` is not still
sitting in your `.env`.

## Using your own proxy instead

nginx, Traefik, HAProxy or an existing Caddy all work. There's nothing
special about the app: terminate TLS, forward to the container on port 3000,
and set `ORIGIN` to the public HTTPS URL. Don't use the overlay in that
case, just publish `APP_PORT` as usual and point your proxy at it.

Two things to carry over yourself:

- Set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` on the app so the
  per-IP rate limits see real client addresses. Only do this once the app is
  no longer reachable except through your proxy: while it's directly
  reachable, that header lets anyone claim any address.
- Drop the `code` and `state` query parameters from the access log if you
  plan to use bank sync, and `q` as well: it's the `/transactions` search
  term, so it carries whatever merchant or amount the user typed to find
  their own transactions. An access log is the one place that would hold that
  in plaintext outside the database.
