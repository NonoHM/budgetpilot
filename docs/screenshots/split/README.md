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

The 14 default categories are stored under canonical French names and
translated for display. They were renamed to their English labels through the
Categories page before capture, so every surface agrees. Without that, the
split editor's part picker shows the stored name where the rest of the app
shows the translation.

Re-taking them: `scr/seed-docshots.mjs` and `scr/rename-categories-en.mjs`
reproduce the data, and both are ignored by git.
