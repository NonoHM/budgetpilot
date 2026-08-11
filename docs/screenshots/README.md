# Screenshots

One convention for every image in this repository.

## Naming

`<state>-<viewport>.png`, where `<viewport>` is one of:

| Viewport  | Size        |
| --------- | ----------- |
| `desktop` | 1920 x 1080 |
| `mobile`  | 393 x 852   |

A state with no `mobile` file means the mobile rendering does not differ in
any way the page is trying to show, not that it was forgotten.

## Where images live

- **This folder** holds the three images the root `README.md` embeds. They
  are the product's shop window, and they are generated, not taken by hand.
- **One folder per feature** holds the images a documentation page embeds,
  for example [`split/`](./split/). Each has its own README recording how
  its data was produced.

## Figures that move on their own

The dataset behind every generated image is relative to the day it was
captured. A screen showing a countdown, a deadline or a per-day rate
therefore renders a different number every time it is shot. The dashboard's
budget alert is the clearest case: one capture reads `€11.90 remaining, 22
days left, about €0.54 a day` and the next reads `€11.90 remaining, 21 days
left, about €0.57 a day`. Nothing changed but the date.

**That is not a defect and it is not something to re-measure.** Each figure
is correct on the day it was taken. Alt text quoting one of these numbers
has to follow the image it describes, so a reshoot usually means editing the
prose beside it too.

The consequence worth planning for: **a reshoot is never scoped to the
change that prompted it.** Retaking two images after a string fix
re-rendered five others in the same groups, identical except for their
dates. Capture the whole group, then keep only the files the change actually
touched and restore the rest.

## Language

Every image is captured in **English**, with both the `PARAGLIDE_LOCALE`
cookie and the `Accept-Language` header set, and the generator reads the
rendered `lang` attribute back before it writes a file.

One thing to check before capturing any screen that names a category: the
14 seeded default categories are **stored** under canonical French names and
translated for display. Most surfaces show the translation, but the split
editor's category picker shows and searches the stored name, so an English
capture of that picker reads `Alimentation` while the row behind it reads
`Groceries`. Where that matters, the defaults were renamed to their English
labels through the Categories page first. Check which name a surface shows
before shooting it rather than after.

## Reproducing the three README images

```bash
SCRATCH_DIR=/tmp/bp-demo node scripts/demo-screenshots.mjs
```

The script builds the app, starts it against a throwaway SQLite database,
seeds a fictional dataset through the real HTTP form actions, and writes
`dashboard-desktop.png`, `budgets-desktop.png` and `net-worth-desktop.png`.
No real financial data is involved anywhere: every merchant, amount and
account name is invented.

Two things about it are worth knowing before changing it.

**Its dataset is relative to the day it runs.** The previous version pinned
every date to a fixed calendar, so its output was correct on the day it ran
and decayed silently afterwards. That is how the README shipped a dashboard
image with a cash-flow card reading `+€0.00 projected by month end` and a
navigation bar missing a page that had since been added.

**It asserts what each image is supposed to show before writing it.** The
dashboard must show a non-zero forecast, the budgets page must show one
category over and one under, the net worth page must have a history chart.
A generator that cannot fail always produces something, and something is
exactly how a forecast of zero became the headline image.
