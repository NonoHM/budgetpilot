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

## Registration always says the token is invalid

You paste the `BOOTSTRAP_TOKEN` and the form rejects it every time, with
nothing in the logs.

Almost always: `BOOTSTRAP_TOKEN` is empty in `.env`. Unlike the other two
secrets, a blank one doesn't crash the app, it just makes every token
comparison fail. Check with:

```bash
grep BOOTSTRAP_TOKEN .env
```

If it does have a value, then it's a copy-paste problem. Copy the entire
value after the `=`, including any trailing `=` characters, with no leading
or trailing space and no line break in the middle.

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

If you changed the port, remember `APP_PORT` and `ORIGIN` both have to move.
Restart after editing.

## Login succeeds then bounces me straight back to the login page

You're reaching the app over plain HTTP at something that isn't localhost:
a LAN address like `http://192.168.1.42:3000`, or a bare hostname.

The session cookie is `Secure` on any Docker install, and browsers refuse to
store a `Secure` cookie on a plain-HTTP origin unless it's `localhost` or
`127.0.0.1`. So the login itself works, the cookie is thrown away, and the
next page load looks logged-out. Setting `PUBLIC_INSTANCE=false` does not
help, it can't remove that flag.

Fix it with HTTPS (a reverse proxy with a real certificate, or Tailscale) or
by tunnelling so the browser still talks to localhost:

```bash
ssh -L 3000:localhost:3000 you@your-server
```

Full explanation in
[configuration](./configuration.md#plain-http-only-works-on-localhost).

## Port is already allocated

```
Error response from daemon: ... bind: address already in use
```

Something else on the machine owns that port. Find what:

```bash
# Linux/macOS
lsof -i :3000
```

Then either stop it, or move BudgetPilot: set `APP_PORT` **and** `ORIGIN` to
a free port in `.env` and start again.

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

The Generic profile only accepts the columns `date`, `label`, `amount` and
optionally `category`. Any other column is refused rather than guessed at.
Dates are `YYYY-MM-DD` or `DD/MM/YYYY`, amounts are signed, zero amounts are
rejected. Full format in
[getting started](./getting-started.md#first-steps-in-the-app).

If your bank's export doesn't map onto that, a new import profile is a very
welcome contribution, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## I lost my two-factor device

Use one of the recovery codes shown when you enabled it. There's no admin
override, by design: an admin who could disable someone else's second factor
would be a way around it.

Out of recovery codes too? The only way back in is direct database surgery
on `dev.db`, so take that backup.
