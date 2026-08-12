# Rules screenshots

Captured with:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs rules
```

against an instance seeded by `scripts/demo-screenshots.mjs`.

## The arrangement they need

**One rule of the user's own**, alongside the 156 that ship, created by the
seed:

| Field           | Value                |
| --------------- | -------------------- |
| Name            | Bakery is dining out |
| Text to match   | `paul`               |
| Target category | Dining out           |
| Target nature   | none                 |

Without it every row in the table is an identical `PREDEFINED` one and no
image can show what a rule you wrote looks like.

The seed creates this rule against the category's French name, and the
capture script's rename into English carries it: a category's name is stored
in the rule too, and renaming the category moves every reference to it. So
the value above is what the page shows after capture, not what the seed
wrote.

It also gives the preview a row that **changes** something, next to the
shipped rules matching transactions already in the right category, which
change nothing. Both outcomes are in one image, so the affected count reads
as the upper bound it is rather than as a promise of that many edits.

`preview-desktop.png` is captured from `/rules?preview=1`.

## Language

English, with the browser locale pinned as well as the app's. See
[the screenshots README](../README.md).
