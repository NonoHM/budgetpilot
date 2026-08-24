# Your account and settings

**Settings** is the screen you reach from the avatar in the top right. It
holds everything about your account rather than about your money.

![The Settings page: an Account card with the email and role, a Security status card, the Language selector, the password card, the two-factor card, and the sessions list](../screenshots/account/overview-desktop.png)

## What is on it

| Section            | What it is for                                           |
| ------------------ | -------------------------------------------------------- |
| Account            | Your email and your role                                 |
| Security status    | Whether the local AI is on, and when you last signed in  |
| Language           | The interface language                                   |
| Security           | Changing your password                                   |
| Two-factor         | [A second check at sign-in](./two-factor.md)             |
| Sessions           | Every device signed in as you                            |
| Tags               | Renaming, recolouring and deleting [tags](./tags.md)     |
| Accounts           | The accounts your imports go into                        |
| AI insights        | The optional [local AI advice](../ai-insights.md)        |
| Backup and restore | [Exporting and restoring your data](./backup-restore.md) |
| Delete my account  | Removing the account and its data                        |

Your email cannot be changed from here, and your role is shown rather than
chosen: only an administrator changes who is one.

## Change your language

![The Language card, with a selector reading English](../screenshots/account/language-desktop.png)

The choice takes effect at once and is remembered for about **400 days**.

Two things about it are worth knowing, because both surprise people:

- **It is stored in the browser, not on your account.** Signing in from a
  second device starts that device on whatever language it negotiates from
  the browser, not on the one you picked here.
- **It overrides your browser's language from then on.** Once you have
  chosen, changing your browser's preferred language no longer moves the
  app; come back here instead.

## Change your password

**Change password** asks for the current one, then the new one twice. A new
password must be at least **12 characters**.

Saving it **signs every other session out** and keeps the one you are using.
That is the point rather than a side effect: if you are changing your
password because you think somebody else has it, the change is what removes
their access.

## See where you are signed in

![The Sessions card: a count of active sessions, the current one with its creation and expiry dates, a "Log out other sessions" button, and a "View session details" disclosure](../screenshots/account/sessions-desktop.png)

Each sign-in creates a session that lasts **30 days**. The list shows how
many are active, marks the one you are using, and expands to show the rest.

- **Log out this session** signs you out here.
- **Log out other sessions** signs out everywhere else and leaves you
  signed in.

A phone you no longer own, or a browser on a shared machine, is a session
here until it expires. That button is how you end it.

## Your accounts

Every import goes into an **account**, and **Settings, Accounts** is where you
manage them.

You do not create accounts here. Your first import makes the first one, and
later imports either reuse it or ask you which one to use.

![The Accounts card: the heading Accounts above "The accounts your statements come from", an invitation reading "These accounts came from your imports. Name them the way your bank names them.", and one row reading CSV import with 13 transactions, Rename and Archive buttons, and a "Tracked in net worth" selector reading None](../screenshots/account/accounts-desktop.png)

Each row shows the account's name, the last four digits of its number when your
bank printed them, and how many transactions it holds. The count is handy when
two accounts at the same bank have similar names.

### Rename

**Rename** changes the name and nothing else. Your transactions and your imports
stay exactly where they are.

BudgetPilot names your first accounts for you, after the bank the statements
came from. One of them may be called **CSV import**, which is what it uses for
files it could not match to a bank. If you have any of those, the page invites
you to give them your own names, and the invitation goes away once you have.

### Archive

**Archive** hides an account from the import screen and changes nothing else.
Its transactions stay where they are and stay visible. Use it for an account you
have closed, so it stops being offered every time you import.

**Reactivate** on the same row brings it back.

An archived account keeps its name and its number, so you cannot reuse either
for a new account while the old one exists.

### Tracked in net worth

Each row has a selector linking the account to a line on your [net worth
page](./net-worth.md), or to none.

Link them and the two become one thing: the balance you track and the statements
you import are about the same account, rather than two separate records of it.

This used to be asked on the import screen. It belongs here, because it is a
question about an account rather than about a file.

## Delete your account

At the bottom, and irreversible. It removes your account and everything in
it: transactions, categories, budgets, rules, net worth history, goals,
tags.

Deleting takes two things, and they answer two different questions.

- **The confirmation phrase** confirms that you mean it. Type it exactly as
  shown, in capitals. It follows the interface language: `DELETE` in English,
  `SUPPRIMER` in French.
- **Your current password** confirms that it is you. When you have an
  authenticator app enabled, a valid six-digit code is required as well, the
  same pair that turning that app off asks for.

So a session someone left open cannot delete the account on its own: it also
needs the password, and the code if you have one. If you have lost your
password, change it first from the same page; there is no way to delete
without it.

Only your own account goes. Other accounts on the same instance are
untouched, and so is the instance itself.

If what you want is a copy of your data before it goes, take one first:
[exporting and restoring your data](./backup-restore.md).

---

For the exact password rules, the session lifetime, and what each control
touches, see the [account reference](../reference/account.md).
