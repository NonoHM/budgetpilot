# Account screenshots

Captured with `scripts/doc-screenshots.mjs`, group `account`, at 1920x1080
against a running instance in English.

`overview-desktop.png` is the whole page down to the sessions list. Its
sessions count is trimmed to four before capturing: the scripted logins that
build the instance leave a dozen behind, and a page reading _12 ACTIVE_
teaches the wrong thing about what a session is.

The two-factor card appears in this image in its **off** state, which is
correct for a page that goes on to explain how to turn it on. The enabled
state is in `two-factor/`.

`accounts-desktop.png` is the Accounts card, and it needs the instance to hold
**at least one account**, which means at least one import. The section renders
its heading either way, and the empty state is a different picture with a
different sentence, so the shot **asserts its premise before the file is
written**: at least one row carrying a Rename control. Without that assertion a
capture taken on an instance that had never imported would quietly write the
empty state under a caption describing rows.
