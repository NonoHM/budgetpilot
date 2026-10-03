# What the security log records about you

**Audience:** anyone with an account on a BudgetPilot instance. **Type:** explanation.

The instance you use keeps a technical log. This page tells you what goes into it, what never does,
and how long it is kept. The person who runs the instance can read the log, and so can anyone they
give access to.

## What it records

The log records how the server is running: when it started and with which security settings, a
page that could not be found, and an error the server did not expect, with the reference the error
page showed you. If you report a problem, that reference lets the person who runs the instance find
the matching line.

Each line holds the time, the kind of event, the page's address pattern (for example
`/imports/[batchId]`, never the address you typed), and a few numbers or codes.

## What it never records

Nothing the application writes to the log holds any of these:

- Your password, your two-factor codes, your recovery codes, or any other credential.
- Your amounts, transaction labels, categories, account names or bank details.
- Your email address.
- Your IP address in readable form.

The application is built so that a line cannot hold these: each field has a fixed definition of
what it may contain, and an automated check, run on every change to the code, fails if a password,
code or key it planted shows up in the log.

Two kinds of output share the log and are not written by the application, so these promises do
not cover them: the database tool that runs when the server starts, whose error message on a
failed update can quote a stored value ([#846](https://github.com/NonoHM/budgetpilot/issues/846)),
and the error report Node itself prints if the server fails before it has finished starting.

## Sign-in events

Sign-ins are not recorded in this version. When they are
([#250](https://github.com/NonoHM/budgetpilot/issues/250)), each sign-in event carries a scrambled
form of your IP address, made with a secret key that only the instance holds. Anyone without that
key cannot turn it back into your address. The person who runs the instance holds the key, so they
can.

## How long it is kept

The shipped setup keeps at most 50 MB of log per service and deletes the oldest lines when it is
full, so how long a line lasts depends on how busy the instance is. If the person who runs the
instance copies the log elsewhere, they set the retention there. The French data protection
authority recommends between six months and a year.

## Questions

Ask the person who runs your instance. They can show you what the log holds and change how long it
is kept.

---

If you run the instance, [the operator's logging reference](../logging.md) lists every event and
every field.
