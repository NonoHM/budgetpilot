# Account settings: rules and figures

Checked against a running instance, not recalled. For what each control
does, see [your account and settings](../using/account.md).

## Password

|                               |                   |
| ----------------------------- | ----------------- |
| Minimum length                | **12 characters** |
| Maximum length                | 256 characters    |
| Requires the current one      | yes               |
| Other sessions after a change | **all revoked**   |
| The session you are using     | kept              |

No character-class rule: length is the whole requirement. The card in
Settings states the session consequence itself, so it is not a hidden
effect.

A wrong current password, a mismatch between the two new fields and a
too-short password all return the same message. That is deliberate for the
first and unhelpful for the other two, but no figure it displays is wrong.

## Sessions

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Lifetime    | **30 days**, `SESSION_TTL_DAYS`                       |
| Created     | one per sign-in                                       |
| Shown       | count of active, plus every session with its dates    |
| Current one | marked, and never revoked by "log out other sessions" |

A session ends when it expires, when it is revoked from this page, or when
the password changes.

## Language

|           |                               |
| --------- | ----------------------------- |
| Stored in | a cookie, `PARAGLIDE_LOCALE`  |
| Lifetime  | **400 days**                  |
| Scope     | that browser, not the account |
| Applies   | immediately                   |

Because it is a cookie rather than an account field, the same account on two
devices can render in two languages, and each device keeps its own choice.

The cookie is written the first time a page hydrates, and from then on it
takes precedence over the browser's `Accept-Language`. So changing the
browser's preferred language no longer changes the app: this control does.

Adding a language is an install-level change, not a setting:
[configuration](../configuration.md).

## Deleting the account

|                     |                                                             |
| ------------------- | ----------------------------------------------------------- |
| Confirmation phrase | follows the locale: **`DELETE`** (en), **`SUPPRIMER`** (fr) |
| Also requires       | the current password, plus a TOTP code when enabled         |
| Scope               | the current account only                                    |
| Reversible          | no                                                          |

The phrase confirms intent; the credential authenticates. The phrase alone
used to be enough, which meant an open session could delete the account with
nothing the session holder had to know. Deletion now re-verifies the current
password, and a valid six-digit code when an authenticator app is enabled,
the same pair `Disable two-factor` asks for. The check is rate limited on the
shared re-auth counter, so a wrong password or code is throttled rather than
being an unlimited guessing oracle.

The phrase also follows the interface language now, so an English instance
asks for `DELETE` rather than the French `SUPPRIMER` it displayed before.

One consequence worth stating: an operator who has lost their password can no
longer delete their own account from the interface. That is the point of the
change, not a regression; the password must be reset first (an admin can do
that, or the user can change it from the same page while still signed in).

Deletion removes transactions first and the user afterwards, rather than
relying on the database's cascade order. Both orders delete the same rows on
SQLite and MySQL; on PostgreSQL the cascade reaches `Category` before
`Transaction`, and `TransactionSplit` restricts on the category, so the
delete would fail outright for any account that has ever split a
transaction.

## What Settings does not do

|                      | Where instead                                                  |
| -------------------- | -------------------------------------------------------------- |
| Change your email    | nowhere; it is fixed at registration                           |
| Change your own role | only an administrator, in [the admin panel](../using/admin.md) |
| Create a tag         | on a transaction, see [tags](../using/tags.md)                 |
| Add a language       | [configuration](../configuration.md)                           |

## Related

- [Two-factor authentication](./two-factor.md), the other half of the
  security section.
- [Backup and restore](./backup-restore.md), for the export and restore
  buttons on the same page.
