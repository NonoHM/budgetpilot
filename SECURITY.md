# Security Policy

BudgetPilot is a local-first personal finance app. It is designed so that,
by default, your financial data never leaves your machine: no bank cloud
sync, no scraping, no mandatory external calls. Optional features (local AI
via Ollama, PSD2 bank connections via Enable Banking) are opt-in and gated
behind explicit configuration and host allowlists.

## Supported versions

BudgetPilot is currently pre-1.0 and released on a rolling basis (see
[CHANGELOG.md](./CHANGELOG.md)). Only the latest published release is
supported with security fixes. There is no LTS branch at this stage.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via
[GitHub Security Advisories](https://github.com/NonoHM/budgetpilot/security/advisories/new)
for this repository. Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is very helpful).
- The affected version/commit.

You should get an initial response within a few days. As a solo-maintained
project there is no formal SLA, but security reports are treated as the
highest priority.

## Security posture (high level)

- **Authentication**: opaque, hashed session tokens; bcrypt password hashing
  (cost 12 minimum); active login rate limiting (per email and per IP);
  optional TOTP/MFA with encrypted secrets and recovery codes.
- **Data isolation**: every sensitive query is scoped to the authenticated
  user; the client never controls which user's data it can read or write.
- **Registration**: closed (`admin_only`) by default, and self-registration
  must be explicitly opted into.
- **Cookies**: the session cookie is forced `Secure` whenever the instance
  declares itself public (`PUBLIC_INSTANCE=true`), independent of
  `NODE_ENV`.
- **Sensitive data at rest**: banking connection credentials and MFA secrets
  are encrypted (AES-256-GCM); raw metadata and banking payloads are never
  logged.
- **External calls are opt-in and allowlisted**: neither the local-AI
  (Ollama) integration nor the optional bank-sync (Enable Banking, PSD2)
  integration will contact any host that isn't on an explicit,
  configurable allowlist. Both are disabled by default.
- **Backup/restore**: exports are scoped to the requesting user only; a
  restore is a full, transactional replacement, never a silent merge.

If you're evaluating BudgetPilot for a security-sensitive deployment, read
[`.env.example`](./.env.example): every security-relevant environment
variable is documented there with its safe default and the reasoning behind
it.

## Penetration testing and retest policy

A full application penetration test is the annual-equivalent baseline. It
attacks the running instance (access control both axes, injection, XSS, CSRF,
authentication and session, file upload, backup-restore integrity, SSRF, and
the money invariants) with reproducible evidence. It is the adversary-emulation
layer, and it does not overlap with the automated scanning below.

After a baseline pass, a **new pass is run only when a change touches one of
these surfaces**:

- authentication or session handling;
- a write path, or a new one;
- a new user-supplied input that reaches storage or rendering;
- access control, horizontal or vertical.

A change that touches none of these does not need a pass. By that rule:

- **Needs a full pass**: account reconciliation, and any OIDC or passkey work.
- **Needs a short pass** (it touches a money read): the computed-balance work.
- **Does not need a pass**: the Sankey view, loan-amortisation display, and
  pure rendering changes.

Releases follow the process in [`CONTRIBUTING.md`](./CONTRIBUTING.md); this
policy decides whether a release's changes require a security pass before it
ships, so it is not re-argued each time.

**Automated scanning is not a substitute.** The daily image scan, the publish
gate, per-PR Trivy, and CodeQL cover known-CVE exposure and configuration
drift. They are not adversary emulation and do not replace the pass above.
