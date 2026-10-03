# Standards, tracked verbatim

Audience: a contributor or reviewer who follows a citation such as `ASVS v5.0.0-8.2.2` or
`AISVS v1.0-C9.2.1` and wants the requirement text.

These are third-party works, copied so that a citation resolves from a clone. The text is unmodified
except one line, recorded in `aisvs-1.0/PROVENANCE.md`:

| Standard | Folder | Source | Licence |
|---|---|---|---|
| OWASP ASVS 5.0.0 | [asvs-5.0.0/](./asvs-5.0.0/) | https://github.com/OWASP/ASVS | CC BY-SA 4.0 |
| OWASP AISVS 1.0 | [aisvs-1.0/](./aisvs-1.0/) | https://github.com/OWASP/AISVS | CC BY-SA 4.0 |

## Licence

**This directory is not under the repository's Apache License 2.0.** Every file here is the work of
the OWASP Foundation and its contributors, and is available under the Creative Commons
Attribution-ShareAlike 4.0 International licence (`LICENSE.md` in each folder). Redistribution is
permitted with attribution and under the same licence, which is why the licence text travels with
the standard text. Each folder's `PROVENANCE.md` names the upstream address and the exact release
or commit the copy was verified against.

The rest of the repository, including the code that reads these files, stays under Apache 2.0.

## Why they are verbatim

`SHA256SUMS` in each folder lets anyone check the copy against upstream (the one changed file is named in its provenance record). `.prettierignore` excludes
this directory so formatting cannot change a byte, and the em dash rule for prose is about our own
writing, not a standard quoted as published. The two `PROVENANCE.md` files and this page are ours.

## Resolving a citation

    node .claude/skills/cite/scripts/resolve.mjs 8.2.2 aisvs:9.2.1

prints each identifier with its level and text, and exits 1 on an identifier that does not exist.
The assessments that cite these standards (the L1 mapping and the L2 report) are not standards and
are not here; [asvs-deltas.md](../asvs-deltas.md) records what moved since.
