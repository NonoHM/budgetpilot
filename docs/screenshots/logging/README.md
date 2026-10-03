# Logging screenshots

Naming and sizes follow [the screenshots convention](../README.md): `<state>-<viewport>.png`, desktop
at 1920 x 1080. Neither image has a mobile file, because neither page is meant to be read on a phone
in a way that differs.

| Image                                                          | Page that embeds it                                        | What it shows                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`error-reference-desktop.png`](./error-reference-desktop.png) | [The tutorial](../../logging-tutorial.md)                  | The error page of a failed Net worth request, with its reference                                     |
| [`grafana-explore-desktop.png`](./grafana-explore-desktop.png) | [Send the log to a collector](../../logging-collectors.md) | Grafana Explore running the LogQL query for one error reference on Loki, and the one line it returns |

Both images are taken by the `logging` group of `scripts/doc-screenshots.mjs`, which asserts on the
screen before it writes a file: the first shot refuses to write unless the page carries an
`Error reference:` line, and the second unless Grafana shows the line of that same reference. The
data is synthetic: one account, `paul.mercier@example.test` (holder Paul Mercier, who does not
exist), no transactions. No address, name or path of the machine appears in either. Look at each
image before committing a new one: the private-reference scanner reads text, not pixels.

## How to re-take them

The script attaches to instances you started. The group needs three things in place.

1. A BudgetPilot instance on an empty volume with the account above registered, as in
   [the tutorial](../../logging-tutorial.md), and the Alloy, Loki and Grafana containers of
   [Send the log to a collector](../../logging-collectors.md) running against it.
1. The Net worth page failing, with the command in tutorial step 5.
1. The environment variables the script reads.

Then run:

```bash
BASE_URL=http://localhost:3000 \
DOC_EMAIL=paul.mercier@example.test DOC_PASSWORD=<the account's password> \
GRAFANA_URL=http://localhost:3001 \
node scripts/doc-screenshots.mjs logging
```

Put the table back afterwards with the command in tutorial step 6.

The reference on the error page is different on every capture, and the second image searches for
the reference the first one read, so the two images are always about the same failure. The alt text
in the pages does not quote a reference.

The Logs volume chart in the Grafana image can read « Data outside time range ». The single line
the query returns sits at the right edge of the three-hour window, and the result under the chart is
the line. The image shows the Grafana interface of the version pinned in the recipe, and the name of
the test container in the small `container=` label above the result. It ages with Grafana's
interface: retake it when the pinned version changes.
