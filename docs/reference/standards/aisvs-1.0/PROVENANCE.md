# AISVS 1.0, local copy

Brought into the tree so that a session can cite the standard from a file rather than from memory,
which is the rule this copy exists to make keepable. Nothing here is a mapping and nothing here is
a claim about this application. See #536.

## What this is

OWASP Artificial Intelligence Security Verification Standard, version 1.0.

| | |
|---|---|
| Source repository | https://github.com/OWASP/AISVS |
| Folder | `1.0/`, which the project declares frozen in `LOCKED.md` |
| Pinned commit | `94fbad5acee4e4716bff263a4c455dfd780e53a7` (authored 2026-07-15) |
| Retrieved | 2026-09-11 |
| Licence | CC BY-SA 4.0, `LICENSE.md`, confirmed from the repository API rather than from the brief |
| Version stated by the source | `en/0x00-Header.yaml`: "Version 1.0", date June 2026 |

## How to cite it

The standard names its own identifier form in `LOCKED.md`:

> Downstream adopters, auditors, and tooling can cite `v1.0-Cx.y.z` identifiers against this folder
> with confidence that they will not move.

So a citation is `v1.0-C2.1.4`, never the bare `2.1.4`. This is a DIFFERENT form from the ASVS one
(`v5.0.0-5.2.1`), and the two must not be blended. Both exist because requirement numbers move
between versions of a standard; a bare number is not a citation.

## What was counted, and where it disagrees with what was expected

Counted here, on these files, at this commit:

- **12 chapters**, `C01` to `C12`, one file each under `en/`.
- **191 requirements**, counted two ways over the same twelve files: 191 table rows matching
  `| **<c>.<s>.<r>** |`, and 191 occurrences of the string "Verify that". A check for table rows
  the first pattern might have missed returned nothing.
- Levels: **51 at L1, 95 at L2, 45 at L3**, summing to 191.

The session brief that requested this copy said 14 chapters and 514 requirements. Those figures are
not what this commit contains and are recorded here so nobody re-derives them from the brief. The
three appendices (glossary, controls inventory, code generation) are not requirement chapters and
are not counted above; Appendix B alone carries 229 table rows, which is the likeliest origin of a
larger total.

## Integrity

`SHA256SUMS` covers the 22 files of the text (the PDF is explained below). Each `en/` file and the PDF
was checked against the byte size the GitHub contents API reported for the same commit at download time; all 23 matched. That check
exists because an earlier attempt at this download silently wrote 60 to 100 byte error pages over
every path, and only a per-file size print made it visible.

Verify with:

    cd docs/reference/standards/aisvs-1.0 && sha256sum -c SHA256SUMS

## Where this copy lives now

Tracked in this repository since #601, under `docs/reference/standards/aisvs-1.0/`, so that a
citation resolves for a reader who has only a clone. It was first kept in a gitignored
directory that also holds private keys, cookie jars and a TOTP secret and so must stay ignored;
nothing else from that directory moved.

**One line of the text differs from upstream.** Line 13 of `en/0x01-Frontispiece.md` embedded the
licence badge as an image from `licensebuttons.net`, and this repository refuses an image from an
outside host, because rendering it makes the reader's client fetch that address. The line is now the
same badge link without the image: `[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)`.
The licence statement itself is unchanged. The SHA-256 of the upstream file at the pinned commit is
`09d94eaa8146726f96203d9fa196d509fe691018c3425054e284a8f0b8d0f132`, and `SHA256SUMS` here lists the
changed file's own sum, so the other 21 text files and `LICENSE.md` still verify against upstream.

Two further things differ from the first copy. `dist/AISVS-1.0.pdf` (the rendered book, 944871 bytes) was
not carried over: the tracked copy is the standard text, and the PDF is a build of that text that
the pinned commit still serves. Its line was removed from `SHA256SUMS`, which now lists the 22
files present. The text of every other file is unchanged.

The ASVS 5.0.0 copy and its provenance record are in `../asvs-5.0.0/`.
