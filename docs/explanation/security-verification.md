# How this project's security is verified, and by whom

This page exists so you can judge for yourself rather than take a word for
it. It gathers what has actually been done, what it covers, and what it does
not.

**Start with the sentence that governs everything below: no independent
third party has audited this project.** Every piece of verification
described here was performed by the maintainer, on their own code. That is
normal for a solo open-source project and nobody should expect otherwise,
but it is a weaker thing than an external audit by people with no stake in
the result, and this is a finance application. Weigh it accordingly.

You will not find the words "secure", "hardened" or "audited" used bare on
this page. Where a claim is made, it names who made it and what it was
checked against.

## The short version

|                               |                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Penetration test              | By the maintainer, on a local instance. Coverage of the application's actions is complete |
| OWASP ASVS 5.0.0 Level 2      | Self-assessed: 122 of 253 in-scope requirements met, 80 not applicable, 51 exceptions     |
| Asserted on every CI run      | 46 of those 253 requirements, by tests that run on every push                             |
| Static analysis               | CodeQL, every commit and pull request                                                     |
| Dependency and image scanning | Dependabot, Trivy per pull request and daily against the published image                  |
| Supply chain                  | Signed images and SBOMs (cosign keyless), pinned actions, SBOM per release                |
| Database engines              | Every test run against SQLite, PostgreSQL and MySQL                                       |
| Independent audit             | **None**                                                                                  |

## What was actually tested

### The penetration test

An owner-authorised test against a running local instance, attacking access
control on both axes (one user reaching another's data, and a normal user
reaching an admin function), injection, cross-site scripting, request
forgery, authentication and session handling, file upload, backup and
restore integrity, server-side request forgery, and the arithmetic that
produces the figures on screen.

The denominator is stated because a percentage without one means nothing:
the application has **63 form actions across 16 route files, 4 endpoints and
18 loaders**. A request was fired at **every one of the 63 actions**, around
40 of them adversarially rather than merely exercised. The loaders were
fuzzed. **Action coverage is complete.**

An older report put this at 89%, with three actions never fired. Those three
were fired at the close of the automation phase: 13 probes, 0 findings, each
paired with a control proving the probe could see what it was looking for.
The report is corrected in both places it stated the old figure.

Every finding it produced was fixed and shipped. Findings are tracked as
public issues once remediated; the working notes that contain live
reproduction steps are not published, because a reproduction is useful to an
attacker and the issues already say what was wrong.

The strongest areas were closed **by attack** rather than by reading:
access control, authentication and session handling, backup and restore
integrity, and the money invariants. Those are the ones where a wrong answer
costs a user their data or their figures.

### Continuous assertion, which is the part that does not age

An assessment describes one commit on one day. A refactor the next morning
can move any verdict and nothing would notice. That is the honest limitation
of any point-in-time claim, and it is published as such in
[SECURITY.md](../../SECURITY.md).

**46 of the 253 in-scope requirements are now asserted by checks that run on
every push.** Not re-read by a person once a year: run, with a result. They
cover the response-header contract, cross-account authorization, that no
secret reaches the log of the shipped artifact, that no user query returns a
credential it does not need, the cryptographic algorithm allowlist, outbound
request containment and TLS verification, the error body and method surface,
session token entropy and lifetime, spreadsheet parser behaviour, and client
storage and injection sinks.

Five of the forty-six pin an **exception** at its current wrong value. That
is deliberate: a pinned exception forces the published claim to move on the
day the gap is fixed, instead of quietly going stale.

That mechanism was exercised while this page was being written, which is the
best evidence for it. One requirement about bounding a compressed upload was
published as an exception, with the stated reason that measuring it was a fix
and that phase filed rather than fixed. The fix landed, so the reason had
expired and the row moved from exception to verified-by-attack, with a check
now holding it. The figures on this page went from 121 met and 52 exceptions
to 122 and 51. Nothing automated forced that; it was caught by re-deriving
the numbers instead of copying them forward, which is the only reason the
page is not stale on the day it was published.

The cost, measured rather than estimated: **93 assertions for twelve seconds**
on the CI critical path.

Every one of those checks was broken on purpose and watched go red before it
was believed. A test nobody has seen fail is not yet a test.

### Three database engines

The application supports SQLite, PostgreSQL and MySQL, and the test suite
runs against all three, because engines disagree in ways that reasoning does
not catch. A real example: deleting a user account succeeded on two engines
and failed on the third, which meant a user who had ever split a transaction
could not delete their own account. Nothing designed found it; a test
suite's own cleanup did.

### Automated scanning

- **CodeQL** on every commit and pull request.
- **Trivy** against the built image on every pull request, and against the
  published image daily.
- **A publish gate** that refuses to release an image carrying a fixable
  critical or high finding.
- **Dependabot** for dependency updates.
- **An SBOM** published and signed with each release.
- **Signed images**, cosign keyless through Sigstore, from 0.11.1 onward.
  The verification command, including the two flags without which the check
  proves nothing, is in
  [operations](../operations.md). 0.11.0 is not signed: that signing run
  failed, and it is recorded rather than quietly omitted.

One thing worth knowing about that list: **a green Dependabot is not
evidence about what ships.** Dependabot classifies a package by where it is
declared; the image contains the result of dependency resolution. Three
CVEs once reached a published image with zero open Dependabot alerts. The
image scan is the authority, which is why it also runs per pull request.

## The ASVS self-assessment

**Self-assessed against OWASP ASVS 5.0.0 Level 2. 122 of 253 in-scope
requirements met, 80 not applicable with stated reasons, 51 exceptions.
Assessed against commit `f85b37f`, by the maintainer, unverified by any
third party.**

**This is not a claim of compliance, and no such claim exists to make.**
OWASP certifies nobody against ASVS and warns specifically against trust
marks asserting compliance with it. Anyone describing a product as "ASVS
certified" is describing something the standard does not offer. What the
standard does define is the shape of a verification report: state the scope,
summarise every requirement checked rather than only the failures, name the
exceptions. That is what exists here.

Level 3 is deliberately out of scope. It targets systems where a breach
threatens life or critical infrastructure, and claiming its scope in order
to mark most of it not-applicable would inflate the denominator without
saying anything true.

The 51 exceptions are published in full, grouped by area, in
[SECURITY.md](../../SECURITY.md). None of them is a known-exploitable
defect: an exception means a control the standard asks for is absent or
unverified, not that an attack against it has been demonstrated.

**And ASVS is a floor, not a ceiling.** The worst defect this project has
had was a backup payload that could write a split transaction whose parts
did not sum to the parent, inventing money in every total the app displayed,
permanently and undetectably. It maps to almost no ASVS requirement, and the
closest one is answered "met" here, on the strength of the very invariant
that had the hole. A good score on this standard is not a statement that the
figures on your screen are right.

## The two badges, and what each does not mean

**OpenSSF Scorecard** is automated. It scores repository and supply-chain
process: whether workflow tokens are scoped, whether actions are pinned by
commit hash, whether releases are signed. **It does not read this
application's code and does not look for vulnerabilities in it.** A high
score says the repository is run a certain way.

Some of its checks are structurally out of reach for one maintainer:
Code-Review and Contributors need a second person, Branch-Protection is
capped because the higher tier requires a mandatory reviewer, and Maintained
rises on its own as the repository ages. The aggregate is therefore not a
number to compare against other projects or to optimise.

There is a sharper reason not to treat any of it as a target, and it is
measured rather than theoretical. Signed-Releases averages points over recent
releases and **skips releases with no assets**. One release failed in a way
that left it with no assets at all, so it dropped out of the denominator and
**the score went up**. The failed release was worth a point. A metric that
skips missing data rewards absence over imperfection.

**The OpenSSF Best Practices badge is self-certified.** The project answers a
public criteria list and nobody verifies the answers. Every answer and its
justification are visible at
[the project entry](https://www.bestpractices.dev/projects/14059), which is
the only reason it carries weight: you can read what was claimed and check it
against this repository.

**Four criteria are answered "Unmet" on purpose, where a generous reading
would have passed.** If you follow the link, this is the part worth reading:

- **`test_most`**: no coverage instrument is configured, so a claim that the
  suite covers most branches would have nothing behind it. The suite is
  large. Large is not the same as covering.
- **`dynamic_analysis`**: no web application scanner is run. Property-based
  testing exists, and the manual penetration test is not the tool-driven
  input variation this criterion asks for.
- **`dynamic_analysis_enable_assertions`**: run-time invariants exist and are
  enforced, but the criterion asks that they be checked _during dynamic
  analysis_, and there is none for them to be checked during.
- **`warnings_strict`**: TypeScript runs strict and unused variables are an
  error, but the linter sits at its recommended set rather than its strict
  one, so "maximally strict where practical" is arguable rather than true.

## Retest policy

A full penetration test is the annual-equivalent baseline, and a new pass is
triggered by the _kind_ of change rather than by the calendar: anything
touching authentication or sessions, a write path, a new user input that
reaches storage or rendering, or access control on either axis.

The rule, and the worked examples of which planned features do and do not
require a pass, are in
[SECURITY.md](../../SECURITY.md#penetration-testing-and-retest-policy)
rather than restated here, so there is one copy to keep true.

## What is NOT covered

A page listing only strengths is marketing. These are open, known, and
tracked.

- **Eight issues where something on screen may be false or misleading**
  ([#175](https://github.com/NonoHM/budgetpilot/issues/175),
  [#199](https://github.com/NonoHM/budgetpilot/issues/199),
  [#200](https://github.com/NonoHM/budgetpilot/issues/200),
  [#201](https://github.com/NonoHM/budgetpilot/issues/201),
  [#202](https://github.com/NonoHM/budgetpilot/issues/202),
  [#204](https://github.com/NonoHM/budgetpilot/issues/204),
  [#277](https://github.com/NonoHM/budgetpilot/issues/277),
  [#280](https://github.com/NonoHM/budgetpilot/issues/280)). On a finance
  application a wrong figure is the defect class that matters most, and these
  are not fixed.
- **No security event logging**
  ([#250](https://github.com/NonoHM/budgetpilot/issues/250)). Authentication,
  authorization and bypass attempts are all unrecorded. The design exists and
  is deliberate about what it would capture; it is not built. **There is no
  audit trail.** If something happened on your instance, nothing would tell
  you.
- **No layout verification under a longer locale**
  ([#158](https://github.com/NonoHM/budgetpilot/issues/158)).
  Pseudo-localisation is not wired into the suite, so no claim about the
  interface holding up in another language is backed by anything.
- **No screen reader has ever been run against this application**
  ([#188](https://github.com/NonoHM/budgetpilot/issues/188)). Accessibility
  work has been done by reading and by automated checks. That is not the same
  thing.

And the honest structural gap, which is larger than any item above: **almost
nobody uses this application yet.** Every defect described on this page was
found by the people who wrote it. A first real user will find a class of
problem none of this reached, and most likely it will be a bank export that
will not import rather than anything security-shaped.

## The European Cyber Resilience Act

Stated precisely, because it is easy to overstate in both directions.

The Cyber Resilience Act entered into force in December 2024. **This project
has no current obligation under it.** Individual developers, hobbyists and
purely non-commercial open-source projects are explicitly exempt. The
regulation's "open-source steward" role applies to a legal entity providing
systematic, sustained support for a commercial purpose; a single developer
maintaining a project in their free time is not one.

So this section is about **readiness, not compliance**, and no compliance is
owed.

Were the steward obligations ever to apply, they are: a published
cybersecurity policy, cooperation with market surveillance authorities,
reporting of actively exploited vulnerabilities, and effective remediation of
vulnerabilities. **All four are already done voluntarily**: the policy is
[SECURITY.md](../../SECURITY.md), private reporting runs through GitHub
Security Advisories, and remediation is visible in the changelog and the
issue tracker.

The trigger that would change this project's status is **monetisation**. If
that ever happens, the dates worth knowing are **11 September 2026**, when
vulnerability reporting obligations begin, and **11 December 2027**, when the
full set applies.

## Some findings about the verification itself

These are the part a reader can reuse, and each cost something to learn.

**Three of ten planned automated checks did not survive contact with the
code.** An inventory of checks is a list of hypotheses, not a specification.
One would have scanned for a pattern that never appears in this codebase, so
it would have reported clean on a healthy tree and clean on the regression it
existed to catch.

**A false positive does not merely waste attention. It removes the control.**
The sharpest of those three would have flagged 76 files on a perfectly
healthy tree. Whoever met it first would delete it, correctly, and the
deletion would take the half that worked along with it.

**Four measurement harnesses were wrong in one afternoon, and every one of
them failed in the direction that reads as success.** A fuzzer that reached
no accept path reported 5,000 clean refusals. An amplification harness failed
its own known-bomb calibration. A coverage gate reported blind for a file
format that was being exercised thousands of times. Each was caught by a
calibration step rather than by luck, which is why every harness here now has
to detect a known problem before any clean result from it is believed.

**And a measurement proves only what it can tell apart.** A check that
reports the same value whether the system is safe or broken is not a check,
however green it is. Several controls described on this page were rewritten
after that question was asked of them.

---

Corrections to this page are welcome as issues. If you find something it
claims that you cannot verify from this repository, that is a defect in the
page.
