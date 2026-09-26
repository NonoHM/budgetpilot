# What keeps private data out of what this repository publishes

This repository is public, and much of it is written with an AI coding
assistant that commits, opens pull requests and posts comments without a person
approving each action first. Everything it writes is published: files, commit
messages, pull request bodies, issues and comments. This page explains what
stops a secret or a piece of private data from reaching any of those, where each
check runs, and what no check catches.

The rule itself is in `AGENTS.md`, under « Never publish anything derived from a
real statement ». This page is the one place that says how the rule is enforced.
[How this project's security is verified, and by whom](./security-verification.md)
covers the security of the application; this page covers the repository around
it.

## Four classes of data, and who guards each

A guard is a check that refuses. A class with no guard names the issue that
tracks it.

| Class                              | What it is                                                                                                                                | Guards                                                                                                                                                                                       | Where they run                                                                                                                      | What none of them catches                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Secret                             | A credential, token or key                                                                                                                | `scripts/private-references-git.mjs`, `scripts/install-gitleaks.sh`, `.github/workflows/published-text-scan.yml`                                                                             | Git hooks and the pull request check (gitleaks); the daily scan (gitleaks over every ref, TruffleHog over issues and pull requests) | A secret in a format neither scanner has a rule for                      |
| Private reference                  | A claude.ai address, a path inside a home directory, a personal email address, an image from an outside host, a secret scanner's skip tag | `scripts/private-references.mjs`, `.claude/hooks/private-references.mjs`, `scripts/private-references-git.mjs`, `scripts/published-text-scan.mjs`, `src/lib/prose/privateReferences.spec.ts` | Agent hook, git hooks, pull request check, daily scan, and the unit suite over every tracked file                                   | Text typed by hand in the GitHub web UI, until the next daily scan       |
| Personal or statement-derived data | An IBAN, and anything else taken from a real bank export                                                                                  | `scripts/private-references.mjs` (IBAN, with the ISO 13616 mod-97 check)                                                                                                                     | Everywhere the private-reference matcher runs                                                                                       | A date, an amount, a label or a row count with no pattern to match: #755 |
| Image metadata                     | Text inside an image or a PDF, such as the path it was saved from                                                                         | `src/lib/prose/privateReferences.spec.ts` reads tracked binaries as bytes                                                                                                                    | The unit suite                                                                                                                      | Anything compressed or encoded inside the file: #755                     |

`privateReferencesClassification.spec.ts` reads this table: every path it names
must exist, and every row must name a guard or an issue.

### Where each guard runs

- **The agent hook**, `.claude/hooks/private-references.mjs`, runs before the
  assistant executes a command. It reads what a `git commit`, a `gh` write, a
  `curl` to the GitHub API or a GitHub MCP tool would publish, including any
  file passed as a body, and refuses on a finding. It fails closed: input it
  cannot parse, a file it cannot read or a value it cannot evaluate is a refusal.
  It also refuses `--no-verify` and any change to `core.hooksPath`.
- **The git hooks**, under `.githooks/`, read the staged lines and the commit
  message whoever typed them, and run gitleaks. `CONTRIBUTING.md` explains how
  to activate them.
- **The pull request check**, `.github/workflows/private-references-pr.yml`,
  reads the diff, every commit message, the title and the body, which is what a
  squash merge copies onto `main`. It runs the base branch's copy of the
  scanner, so a pull request cannot weaken the check that judges it.
- **The daily scan**, `.github/workflows/published-text-scan.yml`, reads what
  is already published: every issue, pull request, comment, review, release and
  commit message, and the history of every branch and tag.
- **The unit suite** reads every tracked file on every run.

Every guard runs a planted positive through its own scanning path in the same
run, and refuses to report clean if the detector misses it.

## References

Each row is one claim this design relies on, with the identifier resolved in the
source's own text.

| Source                                                                                                                                                    | Identifier             | What it says                                                                                                                         | How it applies here                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)                                                             | V13.3.1                | « Secrets must not be included in application source code or included in build artifacts. »                                          | The secret guards, over files and history                                   |
| [OWASP AISVS 1.0, Appendix C](https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x92-Appendix-C_AI_for_Code_Generation.md)                        | AC.3.1                 | « The guidance is enforced in pre-commit hooks, IDE integrations, and CI. »                                                          | The rule is enforced by the git hooks, the agent hook and CI                |
| same                                                                                                                                                      | AC.3.2                 | « secret scanners with pre-prompt hooks all qualify »                                                                                | Hook output is redacted, because it reaches the model's context             |
| same                                                                                                                                                      | AC.4.2                 | « automated security testing runs on every pull request containing AI-generated code: [...] secret scanning »                        | The pull request check                                                      |
| [OWASP AISVS 1.0, C9](https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x10-C09-Orchestration-and-Agentic-Action.md)                             | 9.2.1                  | « the agent runtime blocks execution of privileged, high-impact, or irreversible actions until explicit human approval is received » | Not adopted; see « Decisions and deviations »                               |
| [CWE](https://cwe.mitre.org/data/definitions/540.html)                                                                                                    | CWE-540                | « Inclusion of Sensitive Information in Source Code »                                                                                | The unit suite and the git hooks                                            |
| [CWE](https://cwe.mitre.org/data/definitions/615.html)                                                                                                    | CWE-615                | « Inclusion of Sensitive Information in Source Code Comments »                                                                       | Same guards; comments are not exempt                                        |
| [CWE](https://cwe.mitre.org/data/definitions/532.html)                                                                                                    | CWE-532                | « Insertion of Sensitive Information into Log File »                                                                                 | Every guard prints a redacted form; the workflow logs are public            |
| [CWE](https://cwe.mitre.org/data/definitions/200.html)                                                                                                    | CWE-200                | « Exposure of Sensitive Information to an Unauthorized Actor »                                                                       | The class every guard addresses                                             |
| [CWE](https://cwe.mitre.org/data/definitions/359.html)                                                                                                    | CWE-359                | « Exposure of Private Personal Information to an Unauthorized Actor »                                                                | Personal addresses, home paths and IBANs                                    |
| [CWE](https://cwe.mitre.org/data/definitions/212.html)                                                                                                    | CWE-212                | « Improper Removal of Sensitive Information Before Storage or Transfer »                                                             | The classification above                                                    |
| [MITRE ATLAS](https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.09.yaml)                                                   | AML.T0086              | « Exfiltration via AI Agent Tool Invocation »                                                                                        | The agent hook reads every write channel, not only `gh`                     |
| same                                                                                                                                                      | AML.T0057              | « LLM Data Leakage »                                                                                                                 | The threat the private-reference class describes                            |
| same                                                                                                                                                      | AML.M0033              | « Validation should be performed external to the AI agent. »                                                                         | The pull request check and the daily scan run outside the agent             |
| same                                                                                                                                                      | AML.M0029              | « Human In-the-Loop for AI Agent Actions »                                                                                           | Not adopted; see « Decisions and deviations »                               |
| [MITRE ATT&CK](https://attack.mitre.org/techniques/T1593/003/)                                                                                            | T1593.003, M1047       | « Ensure that any leaked credentials are removed from the commit history, not just the current latest version of the code. »         | The daily gitleaks run reads every ref, not only the tip of `main`          |
| [CIS Controls v8.1 guide](https://omnisoc.iu.edu/resources/crosswalks/cis_controls__v8.1_guide__2024_0801.pdf)                                            | 3.7                    | « Establish and Maintain a Data Classification Scheme »                                                                              | The table above                                                             |
| same                                                                                                                                                      | 3.13                   | « Deploy a Data Loss Prevention Solution »                                                                                           | The IBAN and personal-address kinds                                         |
| same                                                                                                                                                      | 16.12                  | « Implement Code-Level Security Checks »                                                                                             | The git hooks and the pull request check                                    |
| [SLSA v1.2, source track](https://raw.githubusercontent.com/slsa-framework/slsa/v1.2/docs/spec/v1.2/source-requirements.md)                               | Safe Expunging Process | « An organization MUST document the Safe Expunging Process and describe how requests and actions are tracked »                       | The decision record in `.private-references-baseline`                       |
| [OWASP Top 10 CI/CD](https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-06-Insufficient-Credential-Hygiene.md) | CICD-SEC-6             | « automatic scanning upon each code push, and periodical scans on the repository and its past commits »                              | The pull request check and the daily scan                                   |
| [NIST SP 800-218](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf)                                                              | PO.3.2                 | « Follow recommended security practices to deploy, operate, and maintain tools and toolchains. »                                     | Scanners pinned by version and checksum or digest, actions pinned by commit |

The following would apply, and are listed so the reader can see them. **ANSSI is
PROPOSED, not yet mapped** (`AGENTS.md`, « References »), so none of these is
claimed as satisfied.

| Source                                                                                                                                                      | Identifier | What it says                                                                                                                   | Position                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| [ANSSI PA-102](https://messervices.cyber.gouv.fr/documents-guides/Recommandations_de_s%C3%A9curit%C3%A9_pour_un_syst%C3%A8me_d_IA_g%C3%A9n%C3%A9rative.pdf) | R9         | « Proscrire l'usage automatisé de systèmes d'IA pour des actions critiques sur le SI »                                         | Deviated from; see below       |
| same                                                                                                                                                        | R25        | « Protéger le système d'IA en filtrant les entrées et les sorties des utilisateurs »                                           | The agent hook filters outputs |
| same                                                                                                                                                        | R27        | « Limiter les actions automatiques depuis un système d'IA traitant des entrées non-maîtrisées »                                | Not mapped                     |
| same                                                                                                                                                        | R30        | « Contrôler systématiquement le code source généré par IA »                                                                    | Deviated from; see below       |
| same                                                                                                                                                        | R34        | « Proscrire l'utilisation d'outils d'IA générative sur Internet pour un usage professionnel impliquant des données sensibles » | Not mapped                     |
| [ANSSI and BSI, AI Coding Assistants](https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/KI/ANSSI_BSI_AI_Coding_Assistants.pdf?__blob=publicationFile&v=7) | 3.4.2      | « Displaying Markdown images is also a common way to exfiltrate sensitive information »                                        | The external-image kind        |
| same                                                                                                                                                        | 4.1        | « how secrets (e.g., API keys) are currently managed and how they will be protected from leakage »                             | This page                      |

## Decisions and deviations

### No human approval before the assistant publishes or merges

Decided by the owner on 2026-09-26. The assistant commits, posts and merges
without a person approving each action, because an approval prompt on every
write would slow the work more than the owner accepts.

This deviates from AISVS 9.2.1, ATLAS AML.M0029, and ANSSI PA-102 R9 and R30,
all of which ask for a person before a high-impact or irreversible action. The
compensating controls are the guards above: each refuses rather than warns, each
fails closed, and the pull request check and the daily scan run outside the
assistant. The decision is revisited if a leak gets past them.

### Old session trailers are kept, not expunged

Before `attribution.sessionUrl` was set to `false` in `.claude/settings.json`,
Claude Code appended a session address to commit messages, and some of those are
on `main`. They are listed in `.private-references-baseline`, which the daily
scan reads, so it fails only on a finding that is not already there. The scan
fails as well on an entry that no longer matches anything, so the list cannot
outgrow what is actually there.

SLSA's source track allows expunging history « only [...] in order to meet legal
or privacy compliance requirements » and asks that the process be documented.
The documented outcome is not to rewrite: a rewrite does not remove the text from
forks, from pull request refs or from anywhere a commit id was already quoted,
branch protection forbids the force push it would need, and each address points
to a private session no public reader can open. The decision record, with its
date, is at the top of `.private-references-baseline`.
