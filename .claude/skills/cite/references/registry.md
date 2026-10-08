# References

The list is tracked; the copies are not. Which of these bind the project, and how, is AGENTS.md
« References »; the rest is supporting reading.

- **Copies** live in the main checkout under `scr/references/<family>/` (gitignored, so a linked
  worktree reads them through `$(git rev-parse --git-common-dir)/..`), each with a row in that
  folder's `MANIFEST.md`: file, URL, retrieval date, bytes, sha256.
- **Not on disk**: download from the URL below into that folder and add the row. Four works are the
  exception, tracked verbatim with licence and provenance in `docs/reference/standards/`: ASVS 5.0.0
  and AISVS 1.0, which `cite/scripts/resolve.mjs` reads (#601), the OWASP Top 10 for LLM
  Applications 2025, and ANSSI-PA-102 (French and English).
- **Never commit a copy, except those four.** A copy is tracked only when its licence permits
  redistribution and a citation needs to resolve from a clone. Licences differ: the three OWASP works
  are CC BY-SA 4.0 and ANSSI-PA-102 is under the Licence Ouverte 2.0 (redistribution allowed with
  attribution, so the licence travels with them), the CNIL's texts CC BY-ND 4.0 FR, the CIS Controls
  CC BY-NC-ND 4.0, NIST publications public domain, ISO standards are sold.
- **A page that changes without a version** (vendor docs): cite it with the date read; before quoting
  it in published text, save a Web Archive snapshot and put that URL in the MANIFEST row.
- **« URL to record at first use »**: find the primary source, then write its URL here in the same PR.

## OWASP

- ASVS 5.0.0 (flat JSON, the file `cite/scripts/resolve.mjs` reads): https://github.com/OWASP/ASVS/releases/download/v5.0.0_release/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json
- ASVS project page: https://owasp.org/www-project-application-security-verification-standard/
- AISVS 1.0 (pin commit 94fbad5acee4e4716bff263a4c455dfd780e53a7, folder `1.0/en/`): https://github.com/OWASP/AISVS
- AISVS C06 Supply Chain: https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x10-C06-Supply-Chain.md
- AISVS C09 Orchestration and Agentic Action: https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x10-C09-Orchestration-and-Agentic-Action.md
- AISVS C12 Monitoring and Logging: https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x10-C12-Monitoring-and-Logging.md
- AISVS Appendix C, AI for code generation: https://raw.githubusercontent.com/OWASP/AISVS/main/1.0/en/0x92-Appendix-C_AI_for_Code_Generation.md
- WSTG, Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- Top 10 for LLM Applications 2025 (tracked in `docs/reference/standards/owasp-llm-top10-2025/`, pin commit eb87ba80e0698de911dcdb8af60830e97723e3fc, folder `2_0_vulns/`): https://github.com/OWASP/www-project-top-10-for-large-language-model-applications
- Top 10 for LLM Applications 2025, LLM06 Excessive Agency: https://owasp.github.io/www-project-top-10-for-large-language-model-applications/2_0_vulns/LLM06_ExcessiveAgency.html
- Top 10 CI/CD Security Risks, CICD SEC 01 Insufficient Flow Control Mechanisms: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-01-Insufficient-Flow-Control-Mechanisms.md
- Top 10 CI/CD Security Risks, CICD SEC 02 Inadequate Identity And Access Management: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-02-Inadequate-Identity-And-Access-Management.md
- Top 10 CI/CD Security Risks, CICD SEC 03 Dependency Chain Abuse: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-03-Dependency-Chain-Abuse.md
- Top 10 CI/CD Security Risks, CICD SEC 04 Poisoned Pipeline Execution: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-04-Poisoned-Pipeline-Execution.md
- Top 10 CI/CD Security Risks, CICD SEC 05 Insufficient PBAC: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-05-Insufficient-PBAC.md
- Top 10 CI/CD Security Risks, CICD SEC 06 Insufficient Credential Hygiene: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-06-Insufficient-Credential-Hygiene.md
- Top 10 CI/CD Security Risks, CICD SEC 07 Insecure System Configuration: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-07-Insecure-System-Configuration.md
- Top 10 CI/CD Security Risks, CICD SEC 08 Ungoverned Usage of 3rd Party Services: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-08-Ungoverned-Usage-of-3rd-Party-Services.md
- Top 10 CI/CD Security Risks, CICD SEC 09 Improper Artifact Integrity Validation: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-09-Improper-Artifact-Integrity-Validation.md
- Top 10 CI/CD Security Risks, CICD SEC 10 Insufficient Logging And Visibility: https://raw.githubusercontent.com/OWASP/www-project-top-10-ci-cd-security-risks/main/CICD-SEC-10-Insufficient-Logging-And-Visibility.md
- Cheat Sheet: CI CD Security Cheat Sheet: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/CI_CD_Security_Cheat_Sheet.md
- Cheat Sheet: Logging Cheat Sheet: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Logging_Cheat_Sheet.md
- Cheat Sheet: Secrets Management Cheat Sheet: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Secrets_Management_Cheat_Sheet.md

## MITRE

- ATT&CK T1213.003: https://attack.mitre.org/techniques/T1213/003/
- ATT&CK T1552.001: https://attack.mitre.org/techniques/T1552/001/
- ATT&CK T1552: https://attack.mitre.org/techniques/T1552/
- ATT&CK T1593.003: https://attack.mitre.org/techniques/T1593/003/
- ATLAS (data release 2026.09): https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/dist/v6/ATLAS-2026.09.yaml
- CWE-200: https://cwe.mitre.org/data/definitions/200.html
- CWE-212: https://cwe.mitre.org/data/definitions/212.html
- CWE-359: https://cwe.mitre.org/data/definitions/359.html
- CWE-532: https://cwe.mitre.org/data/definitions/532.html
- CWE-601: https://cwe.mitre.org/data/definitions/601.html
- CWE-538: https://cwe.mitre.org/data/definitions/538.html
- CWE-540: https://cwe.mitre.org/data/definitions/540.html
- CWE-615: https://cwe.mitre.org/data/definitions/615.html
- CWE-1295: https://cwe.mitre.org/data/definitions/1295.html
- CWE full catalogue (XML): https://cwe.mitre.org/data/xml/cwec_latest.xml.zip

## NIST

- SP 800-218, Secure Software Development Framework (SSDF): https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf
- SP 800-40 Rev. 4, enterprise patch management: URL to record at first use
- SP 800-53 Rev. 5, security and privacy controls: URL to record at first use
- SP 800-57 Part 1 Rev. 5, Recommendation for Key Management (May 2020; section 5.2 Key Usage), copy in
  `logging/`: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-57pt1r5.pdf

## CIS

- CIS Controls v8.1 (official, behind a registration form; the local copy is a third-party mirror, see its MANIFEST row): https://www.cisecurity.org/controls/v8-1

## ANSSI

- PA-102, generative AI security recommendations, version 1.0 of 29/04/2024 (tracked in `docs/reference/standards/anssi-pa-102/`, Licence Ouverte 2.0) (FR): https://messervices.cyber.gouv.fr/documents-guides/Recommandations_de_s%C3%A9curit%C3%A9_pour_un_syst%C3%A8me_d_IA_g%C3%A9n%C3%A9rative.pdf
- PA-102 (EN): https://messervices.cyber.gouv.fr/documents-guides/security_recommandations_for_a_generative_ai_system.pdf
- PA-102 is still ANSSI's only recommendations guide for a generative AI system: its AI page (https://cyber.gouv.fr/enjeux-technologiques/intelligence-artificielle/, read 2026-10-03) lists nothing superseding it. A « Sécuriser les systèmes intégrant de l'intelligence artificielle » guide of April 2026 that secondary sites describe does not appear there; do not cite it.
- Synthèse de la menace sur l'IA générative face aux attaques informatiques, CERTFR-2026-CTI-001, 4 February 2026, TLP:CLEAR (a threat summary: for the threat model, #840, and for the model supply chain, since it records open-source models that execute code when downloaded): https://www.cert.ssi.gouv.fr/uploads/CERTFR-2026-CTI-001.pdf
- MEPIA, evaluation methods for products integrating AI, v0.1, 15 July 2026, a draft with no licence stated (a Common Criteria evaluation method; its Scenario 1 and the AVA_AINI « AI non-interfering » component are the test method for the AI path: treat the model as an attacker, read everything sent to it, write anything as its answer, and show the application gains no privilege and is not blocked): https://cyber.gouv.fr/documents/797/EN-MEPIA-v0.1PUB.pdf
- Développer la confiance dans l'IA par une approche par les risques cyber, 7 February 2025, Licence Ouverte 2.0. Read 2026-10-03: a high-level risk analysis whose checklist adds nothing PA-102 does not already cover, so it is not a reference here; listed so it is not read again: https://cyber.gouv.fr/documents/582/20250207_np_Analyse_commune_haut_niveau_des_risques_cyber_li%C3%A9_a_IA_V1.0.pdf
- ANSSI and BSI, AI coding assistants (2024): https://www.bsi.bund.de/SharedDocs/Downloads/EN/BSI/KI/ANSSI_BSI_AI_Coding_Assistants.pdf?__blob=publicationFile&v=7
- Publications index: https://cyber.gouv.fr/publications

## European Union

- Regulation (EU) 2024/1689, the Artificial Intelligence Act, OJ L, 2024/1689, 12.7.2024. Permanent identifier (ELI): http://data.europa.eu/eli/reg/2024/1689/oj
- The same, PDF through the Publications Office (EUR-Lex answers scripted downloads with an empty challenge page): https://op.europa.eu/o/opportal-service/download-handler?identifier=dc8116a1-3fe6-11ef-865a-01aa75ed71a1&format=pdf&language=en&productionSystem=cellar&part=
- Corrigendum to the AI Act, OJ L, 2024/90349: URL to record at first use
- Reuse of EU legal texts: Commission Decision 2011/833/EU on the reuse of Commission documents, reuse authorised provided the source is acknowledged and the meaning not distorted; the copy stays local all the same, because the ELI is a permanent address.

## CNIL

- Recommandation journalisation, délibération 2021-122: https://www.cnil.fr/sites/default/files/atoms/files/recommandation_-_journalisation.pdf
- AI practical sheets, index. Read 2026-10-03: all 13 sheets are about developing and training an AI system and none about running one, so they add nothing for this project's AI path and are not a reference; listed so they are not read again: https://www.cnil.fr/fr/les-fiches-pratiques-ia
- AI sheets, verification checklist (July 2025): https://www.cnil.fr/sites/default/files/2025-07/ia_liste_de_verification.pdf
- Licence of CNIL texts: CC BY-ND 4.0 FR, per https://www.cnil.fr/fr/mentions-legales

## ISO/IEC

- ISO/IEC 25010, maintainability (summary page; the standard itself is sold by ISO): https://iso25000.com/index.php/en/iso-25000-standards/iso-25010/57-maintainability
- ISO/IEC 27002:2022, section 8.8: URL to record at first use (sold by ISO)

## Supply chain

- SLSA v1.2, source requirements: https://raw.githubusercontent.com/slsa-framework/slsa/v1.2/docs/spec/v1.2/source-requirements.md
- OpenSSF Scorecard checks: https://raw.githubusercontent.com/ossf/scorecard/main/docs/checks.md

## IETF

- RFC 6238, TOTP: Time-Based One-Time Password Algorithm (May 2011, Informational), copy in
  `auth/`: https://www.rfc-editor.org/rfc/rfc6238.txt
- RFC 5952, A Recommendation for IPv6 Address Text Representation (August 2010, Standards Track), copy in
  `logging/`: https://www.rfc-editor.org/rfc/rfc5952.txt
- RFC 4007, IPv6 Scoped Address Architecture (March 2005, Standards Track), copy in
  `logging/`: https://www.rfc-editor.org/rfc/rfc4007.txt
- RFC 4291, IP Version 6 Addressing Architecture (February 2006, Standards Track), copy in
  `logging/`: https://www.rfc-editor.org/rfc/rfc4291.txt
- RFC 6052, IPv6 Addressing of IPv4/IPv6 Translators (October 2010, Standards Track), copy in
  `logging/`: https://www.rfc-editor.org/rfc/rfc6052.txt
- RFC 8981, Temporary Address Extensions for Stateless Address Autoconfiguration in IPv6 (February
  2021, Standards Track), copy in `logging/`: https://www.rfc-editor.org/rfc/rfc8981.txt

## Operating systems

- Linux `include/uapi/linux/if.h`, `IFNAMSIZ` (interface name buffer, NUL included), tag v6.12, copy
  in `logging/`: https://raw.githubusercontent.com/torvalds/linux/v6.12/include/uapi/linux/if.h
- Linux `net/core/dev.c`, `dev_valid_name` (which interface names the kernel accepts), tag v6.12, copy in
  `logging/`: https://raw.githubusercontent.com/torvalds/linux/v6.12/net/core/dev.c

## Accessibility and testing

- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- ISTQB CTFL v4.0.1 syllabus (section 5.2.3): https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf
- W3C WAI: URL to record at first use
- Nielsen Norman Group, severity ratings and usability testing: URL to record at first use
- MeasuringU, lostness, adjusted Wald, first click: URL to record at first use

## Documentation

- Google developer documentation style guide, UI elements: https://developers.google.com/style/ui-elements
- Microsoft Writing Style Guide: URL to record at first use
- Diátaxis: URL to record at first use
- Write the Docs, docs as code: https://www.writethedocs.org/guide/docs-as-code/
- Vale: https://docs.vale.sh/

## GitHub Docs

- Rulesets: https://raw.githubusercontent.com/github/docs/main/content/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets.md
- Actions: script injections: https://raw.githubusercontent.com/github/docs/main/content/actions/concepts/security/script-injections.md
- Actions: secure use: https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/secure-use.md
- Actions: workflow commands: https://raw.githubusercontent.com/github/docs/main/content/actions/reference/workflows-and-actions/workflow-commands.md
- Available rules for rulesets: https://raw.githubusercontent.com/github/docs/main/content/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets.md
- Secret scanning, configure for a repository: https://raw.githubusercontent.com/github/docs/main/content/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository.md
- Enable push protection: https://raw.githubusercontent.com/github/docs/main/content/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection.md
- Enable secret scanning: https://raw.githubusercontent.com/github/docs/main/content/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning.md
- Secret scanning for generic patterns: https://raw.githubusercontent.com/github/docs/main/content/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enabling-secret-scanning-for-generic-patterns.md
- Push protection for users: https://raw.githubusercontent.com/github/docs/main/content/code-security/how-tos/secure-your-secrets/prevent-future-leaks/manage-user-push-protection.md
- Push protection: https://raw.githubusercontent.com/github/docs/main/content/code-security/concepts/secret-security/push-protection.md
- Removing sensitive data from a repository: https://raw.githubusercontent.com/github/docs/main/content/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository.md
- Repository rules availability: https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/repo-rules.md
- Secret Protection availability: https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/secret-protection.md
- Custom patterns availability: https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/secret-scanning-custom-patterns.md
- Non-provider patterns availability: https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/secret-scanning-non-provider-patterns.md
- Secret scanning availability: https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/secret-scanning.md
- What secret scanning scans: https://raw.githubusercontent.com/github/docs/main/data/reusables/secret-scanning/what-is-scanned.md
- Secret scanning scope: https://raw.githubusercontent.com/github/docs/main/content/code-security/reference/secret-security/secret-scanning-scope.md
- About secret scanning: https://raw.githubusercontent.com/github/docs/main/content/code-security/concepts/secret-security/secret-scanning.md
- Tracking changes in a comment: https://raw.githubusercontent.com/github/docs/main/content/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment.md

## Claude Code docs (living pages: cite with the date read)

- Claude code on the web: https://code.claude.com/docs/en/claude-code-on-the-web.md
- Hooks: https://code.claude.com/docs/en/hooks.md
- Permissions: https://code.claude.com/docs/en/permissions.md
- Sandboxing: https://code.claude.com/docs/en/sandboxing.md
- Security: https://code.claude.com/docs/en/security.md
- Settings reference: https://code.claude.com/docs/en/settings-reference.md
- Settings: https://code.claude.com/docs/en/settings.md
- Memory (CLAUDE.md size, auto memory): https://code.claude.com/docs/en/memory
- Skills: https://code.claude.com/docs/en/skills
- Subagents: https://code.claude.com/docs/en/sub-agents
- Permission modes (auto mode classifier): https://code.claude.com/docs/en/permission-modes

## Tools

- gitleaks: https://raw.githubusercontent.com/gitleaks/gitleaks/master/README.md
- TruffleHog: https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/README.md
- Stryker, vitest runner: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- dependency-cruiser, rules reference: https://raw.githubusercontent.com/sverweij/dependency-cruiser/main/doc/rules-reference.md
- Trivy, filtering: URL to record at first use
