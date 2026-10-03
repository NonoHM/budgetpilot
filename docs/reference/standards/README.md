# Standards, tracked verbatim

Audience: a contributor or reviewer who follows a citation such as `ASVS v5.0.0-8.2.2`,
`AISVS v1.0-C9.2.1`, `LLM10:2025` or ANSSI-PA-102 R3 and wants the text it points to.

These are third-party works, copied so that a citation resolves from a clone. The text is unmodified
except one line, recorded in `aisvs-1.0/PROVENANCE.md`:

| Standard | Folder | Source | Licence |
|---|---|---|---|
| OWASP ASVS 5.0.0 | [asvs-5.0.0/](./asvs-5.0.0/) | https://github.com/OWASP/ASVS | CC BY-SA 4.0 |
| OWASP AISVS 1.0 | [aisvs-1.0/](./aisvs-1.0/) | https://github.com/OWASP/AISVS | CC BY-SA 4.0 |
| OWASP Top 10 for LLM Applications 2025 | [owasp-llm-top10-2025/](./owasp-llm-top10-2025/) | https://github.com/OWASP/www-project-top-10-for-large-language-model-applications | CC BY-SA 4.0 |
| ANSSI-PA-102, security recommendations for a generative AI system (French and English) | [anssi-pa-102/](./anssi-pa-102/) | https://messervices.cyber.gouv.fr/documents-guides/ | Licence Ouverte 2.0 (Etalab) |

## Licence

**This directory is not under the repository's Apache License 2.0.** Each folder carries its own
licence text, because both licences below require it to travel with the work:

- **The three OWASP works** belong to the OWASP Foundation and its contributors, under the Creative
  Commons Attribution-ShareAlike 4.0 International licence (`LICENSE.md` in each folder).
  Redistribution is permitted with attribution and under the same licence.
- **ANSSI-PA-102** is an original creation of the Agence nationale de la sécurité des systèmes
  d'information, placed by the guide itself under the Licence Ouverte 2.0 published by Etalab
  (`LICENCE-OUVERTE-2.0-fr.md` and its English version in the folder). Reuse is permitted with
  mention of the source and the date of its last update, which its `PROVENANCE.md` gives.

Each folder's `PROVENANCE.md` names the upstream address and the exact release, commit or version
the copy was taken from. The rest of the repository, including the code that reads these files,
stays under Apache 2.0.

## Why they are verbatim

`SHA256SUMS` in each folder lets anyone check the copy against upstream (the one changed file is named in its provenance record). `.prettierignore` excludes
this directory so formatting cannot change a byte, and the em dash rule for prose is about our own
writing, not a standard quoted as published, so `emDashesInProse.spec.ts` excludes this directory
too. The `PROVENANCE.md` files and this page are ours.

## Resolving a citation

    node .claude/skills/cite/scripts/resolve.mjs 8.2.2 aisvs:9.2.1

prints each ASVS or AISVS identifier with its level and text, and exits 1 on an identifier that does
not exist. An OWASP LLM Top 10 entry is one file per risk in `owasp-llm-top10-2025/en/`, and an
ANSSI recommendation is cited by its number in the PDF. The assessments that cite these standards
(the L1 mapping and the L2 report) are not standards and are not here;
[asvs-deltas.md](../asvs-deltas.md) records what moved since.

References that are cited but not copied here (the EU AI Act, the CNIL's guidance, and the others)
are listed with their addresses in the `cite` skill's registry,
`.claude/skills/cite/references/registry.md`.
