# Split transaction screenshots

## Naming

`<state>-<viewport>.png`

- `<state>` is what the screen is showing, in kebab-case, named after the
  reader's question rather than the component: `filtered-row`, not
  `TransactionRow`.
- `<viewport>` is `desktop` (1920 x 1080) or `mobile` (393 x 852).

A state with no mobile file is one where the mobile view does not differ
meaningfully, not one that was forgotten.

## How these were taken

Production build, empty database, account created through `/register`, data
seeded to fixed dates and fixed amounts, and the split itself made through the
editor in the browser. The app locale was set to English through the language
control in `/settings`, never by editing anything.

The 14 built-in categories are created under French names, so they were
renamed into English before capture. `scripts/doc-screenshots.mjs` now does
that itself as part of signing in, through the same action the offer on the
Categories page drives, so it is no longer a step to remember.

Every surface agrees on the result, the split editor's part picker included.
It used to be the one that did not: a category's stored name was shown there
while the rest of the app showed a translation, so an English capture read
`Alimentation` in the picker and `Groceries` in the row behind it. A category
now has one name and that disagreement cannot occur.

Re-taking them: `scr/seed-docshots.mjs` reproduces the data and is ignored by
git.
