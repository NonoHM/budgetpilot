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
2. An RSA keypair generated locally. The public half gets uploaded to the
   Control Panel, the private half stays on your machine and never leaves
   it:

   ```bash
   mkdir -p keys
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/enablebanking.pem
   openssl rsa -in keys/enablebanking.pem -pubout -out keys/enablebanking.pub
   ```

   `keys/` and `*.pem` are gitignored. Keep it that way.

3. The redirect URL registered in the Control Panel, matching **exactly**
   what your instance serves:

   ```
   http://localhost:3000/imports/bank-connections/callback
   ```

   The path is fixed and never configurable. The origin must be the same one
   you put in `ORIGIN`. A mismatch here means the consent flow dies on the
   way back from your bank.

## Configuration

```dotenv
BANK_SYNC_ENABLED=true
ENABLE_BANKING_APP_ID=<the application id from the Control Panel>
ENABLE_BANKING_PRIVATE_KEY_PATH=./keys/enablebanking.pem
BANK_SYNC_REDIRECT_ALLOWED_ORIGINS=http://localhost:3000
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
