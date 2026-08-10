# Rules screenshots

Captured with:

```bash
BASE_URL=http://localhost:4175 node scripts/doc-screenshots.mjs rules
```

## The arrangement they need

**One rule of your own**, alongside the 156 that ship. Without it the list
is 156 identical `PREDEFINED` rows and no image can show what a rule you
wrote looks like, which is the thing the page is for.

The one used here:

| Field           | Value                |
| --------------- | -------------------- |
| Name            | Bakery is dining out |
| Text to match   | `paul`               |
| Target category | Restauration         |
| Target nature   | none                 |

It is chosen so the **preview** image shows both outcomes at once: the rule
moves the bakery from Groceries to Dining out, while the shipped `Uber` rule
matches transactions already in Transport and changes nothing. A preview
where every row is a real change would hide the fact that the count is
matches rather than changes.

`preview-desktop.png` is captured from `/rules?preview=1`.

## Language

English, with the browser locale pinned as well as the app's. See
[the screenshots README](../README.md).
