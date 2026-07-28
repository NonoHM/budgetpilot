# Configuration

Everything is configured through `.env`, sitting next to your compose file.
[`.env.example`](../.env.example) is the authoritative reference and carries
a comment on every variable. This page is the prose version: what you'd
actually want to change, and why.

After editing `.env`, restart the app for it to take effect:

```bash
docker compose up -d          # or: docker compose -f docker-compose.prebuilt.yml up -d
```

## The three secrets

Required. The app refuses to start without two of them, and account creation
silently fails without the third.

| Variable                 | What it does                                                                                  | If it's missing                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_TOKEN`        | Gates account creation while registration is closed                                           | The app starts fine, but **every** registration attempt is rejected as an invalid token, with nothing in the logs. If registration keeps failing and you're sure you pasted the right value, check this variable isn't empty |
| `RATE_LIMIT_HASH_SECRET` | HMAC key for the emails and IPs stored by login rate limiting, so they're never in clear text | Crash at startup with `RATE_LIMIT_HASH_SECRET is required`                                                                                                                                                                   |
| `TOTP_ENCRYPTION_KEY`    | AES-256-GCM key encrypting two-factor secrets at rest                                         | Crash at startup with `TOTP_ENCRYPTION_KEY is required`                                                                                                                                                                      |

`TOTP_ENCRYPTION_KEY` is the one to never lose or rotate casually: change it
and every account with two-factor enabled is locked out of its second
factor. `RATE_LIMIT_HASH_SECRET` rotating just resets rate-limit counters.

`npm run setup` regenerates all three, so don't rerun it on an instance you
already use. Edit `.env` directly to flip a single setting.

## Exposing it beyond localhost

This is where most people get stuck, so read it before you try.

### `ORIGIN` has to be exact

`ORIGIN` must be the exact URL you type in the browser, protocol and port
included, no trailing slash. SvelteKit checks it against the `Origin` header
of every form submission as CSRF protection. If it doesn't match, login,
registration and every other form fail with `403 Cross-site POST form
submissions are forbidden`, while the pages themselves load fine.

Different port on the same machine, both values move together:

```dotenv
APP_PORT=3001
ORIGIN=http://localhost:3001
```

`APP_PORT` is the host-side port Docker publishes. The container always
listens on 3000 internally, that never changes.

### Plain HTTP only works on localhost

This one surprises people, so here it is plainly: **a Docker install serves
`Secure` session cookies always**, because the container runs with
`NODE_ENV=production` and the app treats that, on its own, as "this deserves
Secure cookies". `PUBLIC_INSTANCE` can add that flag, it can't remove it.

Browsers accept a `Secure` cookie over `http://localhost` and
`http://127.0.0.1`, which they consider trustworthy origins. They refuse it
over `http://192.168.1.42:3000` or `http://budget.lan`. On those, login
appears to work and then bounces you straight back to the login page,
forever, because the session cookie was never stored.

So reaching the app from another device means one of these:

**A reverse proxy with a real certificate** (Caddy, nginx, Traefik). The
right answer:

```dotenv
ORIGIN=https://budget.example.com
PUBLIC_INSTANCE=true
```

Point the proxy at the container's published port. The app stays on plain
HTTP internally, the proxy terminates TLS. `PUBLIC_INSTANCE=true` is what
makes the cookie policy explicit rather than incidental.

**Or a tunnel**, so the browser still talks to localhost. A Tailscale
tailnet with its HTTPS certificates, or plain SSH port forwarding:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

Then browse `http://localhost:3000` on your laptop, with `ORIGIN` left at
`http://localhost:3000`. Nothing to configure in the app at all.

Exposing this to the open internet is your call to make, but the honest
answer is that a self-hosted finance app belongs on your LAN or behind a
VPN. If you do expose it, use HTTPS, set `PUBLIC_INSTANCE=true`, and leave
registration closed.

## Who can create an account

```dotenv
REGISTRATION_MODE=admin_only   # default
```

- `admin_only`: `/register` requires the `BOOTSTRAP_TOKEN`. The first
  account created becomes an admin. After that, an already-logged-in admin
  can create more accounts, or generate single-use invitation links from the
  admin panel.
- `open`: anyone who can reach `/register` can create an account, protected
  only by IP rate limiting. No CAPTCHA, no email verification. Fine for a
  machine only you can reach, a bad idea on a public URL.

Any unrecognized value falls back to `admin_only`.

## Passwords and sessions

```dotenv
PASSWORD_HASH_COST=12    # bcrypt cost, 12 minimum, 15 maximum
SESSION_TTL_DAYS=30      # how long a login lasts
INVITATION_TTL_HOURS=72  # lifetime of an admin-generated invitation link
```

Raising `PASSWORD_HASH_COST` makes login slower for everyone by design. 12
is a sane default, don't go below it.

Two-factor authentication (TOTP) is per user and opt-in, enabled from
Settings. There's deliberately no admin action to disable someone else's
second factor, so keep your recovery codes.

## Database

```dotenv
DATABASE_URL="file:./dev.db"
```

Only used outside Docker. Both compose files override it to
`file:/data/dev.db`, which lives in the `budgetpilot_data` volume. SQLite is
the only supported engine right now, so this isn't really a knob you can
turn.

## Optional features

Both are off by default, and neither makes a single network call while off.

```dotenv
LLM_ENABLED=false         # local AI advice, see docs/ai-insights.md
BANK_SYNC_ENABLED=false   # automatic bank sync, see docs/bank-sync.md
```

## Upload size

```dotenv
BODY_SIZE_LIMIT=21000000
```

Roughly 20 MB, the cap on an imported statement file. Raise it if you have a
genuinely enormous export.
