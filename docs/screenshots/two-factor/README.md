# Two-factor screenshots

Captured with `scripts/doc-screenshots.mjs`, groups `two-factor`,
`two-factor-on` and `two-factor-verify`, against a **throwaway instance**
created for the purpose and deleted afterwards.

Throwaway matters here rather than being incidental: `setup-desktop.png`
shows a real QR code and its key, and `recovery-codes-desktop.png` shows ten
real recovery codes. They belong to an account that no longer exists, on a
database that no longer exists. **Never recapture these against an instance
holding real data** — the images would publish a working second factor.

The three groups are separate because each needs the account in a state the
others destroy:

| Group               | Needs                                                               |
| ------------------- | ------------------------------------------------------------------- |
| `two-factor`        | an account with two-factor **off**; it walks the enrolment for real |
| `two-factor-on`     | an account with two-factor **on**                                   |
| `two-factor-verify` | the same, signed out, to reach the second step                      |

`two-factor` finishes the enrolment through the dialog rather than through
the API, so the recovery codes photographed are ones the app issued. The
code it types is generated with `otpauth`, the same library the server
verifies with — not a re-implementation of the algorithm.

`DOC_TOTP_SECRET` lets the script pass the second step when capturing an
account that already has two-factor enabled. Without it the capture would run
signed out and photograph the sign-in page.

No account identity appears in any of the five images, which is why they
could be captured under whichever account happened to be free.
