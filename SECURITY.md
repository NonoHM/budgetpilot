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

## Badges, and what they do and do not mean

Two badges are linked from the README. Neither is an audit, and they measure different
things.

**OpenSSF Scorecard** is automated. It scores repository and supply-chain process:
whether workflow tokens are scoped to the job, whether actions are pinned by commit
hash, whether a security policy exists, whether releases are signed. It does not read
this application's own code and it does not look for vulnerabilities in it. A high
Scorecard number says the repository is run a certain way. It says nothing about
whether the figures on your screen are right.

**The OpenSSF Best Practices Badge is self-certified.** The project answers a public
criteria list and nobody verifies the answers. Every answer and the justification
behind it are visible at
[the entry](https://www.bestpractices.dev/projects/14059), which is the only reason it
carries any weight: you can read what was claimed and check each claim against this
repository yourself.

Four criteria are answered **Unmet on purpose**, where a generous reading would have
passed:

- **`test_most`** (does the suite cover most branches, inputs and functionality): no
  coverage instrument is configured, so the claim would have nothing behind it. The
  suite is large, and large is not the same as covering.
- **`dynamic_analysis`**: no fuzzer and no web application scanner is run, and the
  alternative the criterion allows (an automated suite with at least 80% branch
  coverage) is unavailable for the same reason. A manual penetration test was run, and
  it is not the tool-driven input variation this criterion asks for.
- **`dynamic_analysis_enable_assertions`**: run-time invariants do exist and are
  enforced, but the criterion asks that they be checked during dynamic analysis, and no
  dynamic analysis is run for them to be checked during.
- **`warnings_strict`**: TypeScript runs with `strict` and `checkJs`, and unused
  variables are an error rather than a warning, but typescript-eslint sits at its
  `recommended` set rather than `strict`, so "maximally strict where practical" is
  arguable rather than true.

## Verifying what you run

From 0.11.1 onward, every published image is signed with cosign keyless through
Sigstore, and each release SBOM is signed separately. The verification command,
including the two flags without which the check proves nothing, is in
[`docs/operations.md`](./docs/operations.md) under "Checking the image is really ours".
0.11.0 is not signed: its signing run failed, and that is recorded in the same place.

## No independent audit has been performed

Stated plainly, because it is the question this file exists to answer: **no third party
has audited this project.** What exists is verification by the maintainer, documented so
that it can be checked rather than taken on trust:

- an owner-authorised penetration test of a local instance, with the retest rule below;
- a self-assessment against OWASP ASVS 5.0.0 Level 2, summarised in the next section;
- CodeQL static analysis on every commit and every pull request;
- Trivy against the built image on every pull request, and against the published image
  daily, with the publish gate refusing a release that carries a fixable critical or
  high finding.

That is a different and weaker thing than an external audit by people with no stake in
the result, and it should be weighed as such when deciding whether to trust this
project with financial data.

**[How this project's security is verified, and by whom](./docs/explanation/security-verification.md)**
gathers all of it in one place, including what is deliberately NOT covered and where this
project stands under the EU Cyber Resilience Act.

## Self-assessed against OWASP ASVS 5.0.0 Level 2

**Self-assessed against OWASP ASVS 5.0.0 Level 2. 122 of 253 in-scope requirements met
(33 verified by attack, 89 by construction), 80 not applicable with stated reasons, and
51 exceptions. Re-derived 2026-08-13 against commit
[`f85b37f`](https://github.com/NonoHM/budgetpilot/commit/f85b37f), by the maintainer,
unverified by any third party.**

**This is not a claim of compliance, and no such claim exists to make.** OWASP certifies
nobody against ASVS and warns specifically against trust marks that assert compliance
with it. Anyone telling you a product is "ASVS certified" is describing something the
standard does not offer. What the standard does define is the shape of a verification
report: state the scope, summarise every requirement checked rather than only the
failures, name the exceptions, and say how they will be resolved. That is what this is.

Level 1 plus Level 2 is 253 of the standard's 345 requirements. Level 3 is deliberately
out of scope: it targets systems where a breach threatens life or critical
infrastructure, and claiming its scope in order to mark most of it not-applicable would
inflate the denominator without saying anything true.

### The limitation that governs this claim

**It is point-in-time.** ASVS asks whether a control held throughout, not whether it was
present on the afternoon of the assessment. Every verdict describes one commit on one
day. A refactor the next morning can move any of them and nothing here would notice.

Of the 122 met requirements, **104 could be asserted continuously by an automated check**
rather than by a person re-reading the code once a year.

**46 of the 253 in-scope requirements now are**, by tests that run on every push, at a
measured cost of 93 assertions for twelve seconds of CI. Five of the forty-five pin an
exception at its current wrong value, so the published claim is forced to move on the day
that gap is fixed. The rest of the number above remains a measurement with a date on it
rather than a property of the software. What is covered, and what it cost, is in
[how this project's security is verified](./docs/explanation/security-verification.md).

### The 51 exceptions

Published in full, at the level of individual requirements, because an exception list is
the useful half of an ASVS report and withholding it would leave you unable to check the
claim above. They are grouped below rather than tabulated, so that this section stays
true as issues close instead of freezing on the day it was written.

| Area                                      | Exceptions | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security logging                          | 9          | [#250](https://github.com/NonoHM/budgetpilot/issues/250) covers the class: the application records nothing on authentication, authorization or bypass attempts                                                                                                                                                                                                                                                                                       |
| Authentication and recovery               | 11         | No breached-password check, no context-specific denylist, and no self-service password reset ([#155](https://github.com/NonoHM/budgetpilot/issues/155), [#244](https://github.com/NonoHM/budgetpilot/issues/244), [#248](https://github.com/NonoHM/budgetpilot/issues/248))                                                                                                                                                                          |
| Cryptography, transport and configuration | 12         | Includes database TLS ([#251](https://github.com/NonoHM/budgetpilot/issues/251)), HSTS max-age ([#247](https://github.com/NonoHM/budgetpilot/issues/247)), a redirect scheme allowlist ([#245](https://github.com/NonoHM/budgetpilot/issues/245)), cookie prefixes, and secrets held in environment variables rather than a vault                                                                                                                    |
| Documentation of security decisions       | 10         | Data classification, cryptographic inventory, key-management policy, and the per-user data-access rule ([#246](https://github.com/NonoHM/budgetpilot/issues/246))                                                                                                                                                                                                                                                                                    |
| Session management                        | 6          | [Its own milestone](https://github.com/NonoHM/budgetpilot/milestone/7): idle timeout, re-authentication and session termination, grouped because they interlock                                                                                                                                                                                                                                                                                      |
| Availability                              | 3          | Expensive operations have no rate limit, and nothing bounds concurrent imports ([#283](https://github.com/NonoHM/budgetpilot/issues/283)). The two measured denial-of-service paths are now closed: the spreadsheet import bounds what a file expands to ([#254](https://github.com/NonoHM/budgetpilot/issues/254)) and the backup restore bounds a payload's structure before parsing it ([#276](https://github.com/NonoHM/budgetpilot/issues/276)) |

Every exception either has an issue above or is a documentation or hardening gap with no
reachable path to it. **None of the 51 is a known-exploitable defect**: an exception means
a control the standard asks for is absent or unverified, not that an attack against it
has been demonstrated.

Two entries are recorded as contradictions to re-argue rather than defects to fix, which
is the honest description of them: ASVS asks for session-token rotation on
re-authentication, which this project deliberately declined
([#249](https://github.com/NonoHM/budgetpilot/issues/249)), and for configurable
cryptography, which it refuses because a configurable algorithm is a downgrade surface.

### What this does not tell you

The same warning as the two badges above, and it is the one that matters most here.
**ASVS is a floor, not a ceiling.** The worst defect this project has had was a backup
payload that could write a split transaction whose parts did not sum to the parent,
inventing money in every total the app displayed, permanently and undetectably. It maps
to almost no ASVS requirement: the closest one is answered "met" here, on the strength of
the very invariant that had the hole. A high score on this standard is not a statement
that the figures on your screen are right.

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
