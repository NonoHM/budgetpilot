# What the security log records about you

**Audience:** anyone with an account on a BudgetPilot instance. **Type:** explanation.

The instance you use keeps a technical log. This page tells you what goes into it, what never does,
and how long it is kept. The person who runs the instance can read the log, and so can anyone they
give access to.

## What it records

The log records how the server is running. For example:

- when the server started, and with which security settings;
- a page that could not be found;
- an error the server did not expect, with the reference the error page showed you;
- a step of your own work that failed, such as an import that could not be saved or a bank balance
  that could not be fetched;
- a sign-in, a sign-out or a registration, as the next section describes.

If you report a problem, the reference on the error page lets the person who runs the instance find
the matching line.

Each line holds the time, the kind of event and a few numbers or codes. A line about a page names
its address pattern, for example `/imports/[batchId]`, never the address you typed. A line about a
bank balance that could not be fetched also holds the internal number of your bank connection, which
the person who runs the instance can match to your account.

## What it never records

Nothing the application writes to the log holds any of these:

- Your password, your two-factor codes, your recovery codes, or any other credential.
- Your amounts, transaction labels, categories, account names or bank details.
- Your email address.
- Your IP address in readable form.

The application is built so that a line cannot hold these: each field has a fixed definition of
what it may contain, and an automated check, run on every change to the code, fails if a password,
code or key it planted shows up in the log.

## Logs these promises do not cover

Other programs on the same server write logs too, and the application does not control what they
hold:

- **The database tool that runs when the server starts.** If an update fails, its error message can
  quote a stored value ([#846](https://github.com/NonoHM/budgetpilot/issues/846)).
- **Node, the program BudgetPilot runs on**, if the server fails before it has finished starting.
- **The web server in front of BudgetPilot**, if the instance uses the one BudgetPilot ships for
  HTTPS. It keeps a line for every request with your IP address in readable form, the address of
  each page you open with your search terms removed, and the name and version of your browser. The
  person who runs the instance keeps the IP address readable so they can block an abuser, and can
  choose to mask it.

## Sign-in events

The log records each sign-in, sign-out, registration and password confirmation, whether it worked
or not, when the server refused one because of too many attempts, and a visit made with a session
that no longer works. A sign-in line says which step
failed and why, for example a wrong password or a code already used.

These lines never hold your email address, and never your IP address in readable form. They hold
scrambled forms instead, made with a secret key that only the instance holds:

- a scrambled form of your account, so the lines about one account can be found together;
- a scrambled form of your IP address, except on a sign-out and on a session that no longer works;
- on a failed sign-in, a failed password confirmation, or a refusal for too many attempts only, a
  scrambled form of your home network, so that someone trying passwords from many addresses of one
  network can be recognised. A successful sign-in never carries it. A refusal for too many attempts
  can be about you even when someone else made them, and the line says so.

Anyone without the key cannot turn these back into your address or your account. The person who
runs the instance holds the key, so they can.

## How long it is kept

The shipped setup keeps at most 50 MB of log for each program it runs and deletes the oldest lines when it is
full, so how long a line lasts depends on how busy the instance is. If the person who runs the
instance copies the log elsewhere, they set the retention there. The French data protection
authority recommends between six months and a year.

## Questions

Ask the person who runs your instance. They can show you what the log holds and change how long it
is kept.

---

If you run the instance, [the operator's logging reference](../logging.md) lists every event and
every field.
