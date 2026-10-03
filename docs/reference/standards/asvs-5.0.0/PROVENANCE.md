# ASVS 5.0.0, tracked copy

The OWASP Application Security Verification Standard, version 5.0.0, in the flat JSON form that
`.claude/skills/cite/scripts/resolve.mjs` reads. Redistributed under CC BY-SA 4.0 (`LICENSE.md`
here): the standard is by the OWASP Foundation and its contributors, unmodified, and any
redistribution of it carries the same licence. Nothing here is a mapping and nothing here is a claim
about this application. See #601.

| | |
|---|---|
| Source repository | https://github.com/OWASP/ASVS |
| Release | https://github.com/OWASP/ASVS/releases/tag/v5.0.0_release (published 2025-05-30) |
| Release tag commit | `5cf9b032440be53ce345ab3c130fda46ba1ce7a2` (read from the GitHub API, ref `v5.0.0_release`) |
| Asset | https://github.com/OWASP/ASVS/releases/download/v5.0.0_release/OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json |
| Licence | CC BY-SA 4.0. The repository API reports `CC-BY-SA-4.0`; `LICENSE.md` here is `LICENSE.md` at the tag commit, byte for byte |
| Verified | 2026-10-03 |

## What was verified, and how

The asset was downloaded again from the URL above and compared with the copy kept in this
repository: both are 162870 bytes with the same SHA-256 (`SHA256SUMS`). The licence file was fetched
from the tag commit and compared with the one in `../aisvs-1.0/`: identical, 20138 bytes.

Until #601 this copy sat in a gitignored directory with neither a licence nor a provenance record.
This file is that record.

## How to cite it

`v5.0.0-<chapter>.<section>.<requirement>`, never the bare number. Resolve with
`node .claude/skills/cite/scripts/resolve.mjs <id>`.

## Verify

    cd docs/reference/standards/asvs-5.0.0 && sha256sum -c SHA256SUMS

## Do not reformat

The JSON is verbatim. `.prettierignore` excludes this directory so that `lint:tracked` cannot
rewrite it, which would break `SHA256SUMS`.
