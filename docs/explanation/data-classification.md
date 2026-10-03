# How BudgetPilot classifies the data it stores, and what each class may do

**Audience:** contributors who write a log line, an export, a prompt or an outbound request, and
operators who want to know what an instance stores and sends. **Type:** explanation, with reference
tables.

This page answers one question for whoever writes a log line, an export, a prompt or an
outbound request: **what kind of data is this column, and what is that kind allowed to do?**
It contributes to what [`v5.0.0-14.1.1` and `v5.0.0-14.1.2`](#what-this-page-contributes-to-and-what-it-does-not)
ask for. It records current behaviour as fact, with the file that shows it. Where the code does
not yet meet a requirement, it says so and names the issue. It is a snapshot of the tree at
the commit that introduced it, and the figures in it are re-derived with the commands in
[Re-deriving the figures](#re-deriving-the-figures).

The page is written as if the instance operator were a data controller under the GDPR. Whether
a household instance's operator is one has not been ruled, and nothing here claims a legal
conclusion either way. The design assumption is the cautious one.

## The five levels

A column or a transmitted field gets exactly one level. The set is closed: a new kind of data
is placed in one of these five, or this page is changed in the same pull request.

| Level            | What it is                                                                                                  | The test                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Secret**       | Credentials, key material and tokens: a value that lets someone act as the user or reach the bank for them. | Does holding this value grant access?                              |
| **Financial**    | Amounts, dates, labels, names and structure of the user's money, and anything derived from them.            | Does it say what the user spent, earns, owns, owes or categorises? |
| **Personal**     | Identifies the person, or a bank account they hold, without describing their money.                         | Does it name the person or one of their accounts?                  |
| **Pseudonymous** | A keyed one-way hash of a Personal value, held so that a limit can be counted without keeping the value.    | Is it an HMAC under a key kept outside the database?               |
| **Operational**  | Identifiers, timestamps, flags, counters and states that carry no content on their own.                     | Would it mean nothing without the row it describes?                |

Four rules decide the cases the table cannot.

1. **A derived value takes the level of its source, unless the derivation is keyed.** An unkeyed
   SHA-256 of a financial fingerprint (`Transaction.dedupeKeyHash`) is Financial. An HMAC of an
   email under a secret the database does not hold (`LoginAttempt.emailHash`) is Pseudonymous.
   A SHA-256 of a 256-bit random token (`Session.tokenHash`) is Secret, because it is the lookup
   key for the credential.
2. **Free text a person types takes the level of what it is about, and may also hold a third
   party's personal data.** A transaction label is Financial. It can also carry a counterparty's
   name or account number, written by the bank, which is why labels cross the anonymisation
   function before they reach the model (`anonymizeMerchant`, `src/lib/server/reports/monthly.ts`).
3. **Operational is not exempt from the GDPR.** A session timestamp beside a `userId` is a record
   of when a person signed in. The level says what may be logged or sent. It does not say the row
   may outlive the account, which is why the retention and deletion rows below apply to every
   level.
4. **A level is not a ranking.** Where a column needs a stricter rule than its level, the rule is
   named in [Stricter than the level](#stricter-than-the-level).

## What each level requires

The requirements are the ones `v5.0.0-14.1.2` lists: encryption, integrity, retention, logging,
access to logs, database-level encryption and privacy techniques. Export, model, deletion and
outbound requests are added because they are the four places this application sends data
elsewhere. Each cell is the requirement. [What the code does today](#what-the-code-does-today)
says whether it holds.

| Requirement                | Secret                                                                                                                                    | Financial                                                                                                  | Personal                                                                                                                                      | Pseudonymous                                                                                                                                                                             | Operational                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **At rest**                | Hashed one-way or encrypted with AES-256-GCM. Never stored as received.                                                                   | Protected by the database and the volume the operator provides. No column encryption.                      | Same as Financial.                                                                                                                            | HMAC-SHA256 under a key held in the environment, not in the database.                                                                                                                    | No requirement.                                                                                               |
| **In transit**             | HTTPS only. Never in a URL. A remote database over TLS. The stated exceptions are below.                                                  | HTTPS only. A remote database over TLS. The stated exceptions are below.                                   | Same as Financial.                                                                                                                            | Same as Financial.                                                                                                                                                                       | Same as Financial.                                                                                            |
| **Integrity**              | Authenticated encryption, or a hash compared in constant time.                                                                            | Integer minor units with a per-row currency and exponent. Restore validated and atomic.                    | Validated at the boundary.                                                                                                                    | Recomputable from its input and the key.                                                                                                                                                 | Foreign keys and constraints.                                                                                 |
| **Retention**              | Until it expires, is revoked or is spent, then deleted.                                                                                   | Until the owner deletes it or the account.                                                                 | While the account exists.                                                                                                                     | `LoginAttempt`: the rate-limit window plus a margin, then deleted. `RememberedAccount.identifierKey`: until the user forgets it, a later import overrules it, or the account is deleted. | The life of the row it describes.                                                                             |
| **In a log**               | Never.                                                                                                                                    | Never. Counts and error classes only.                                                                      | Never in clear. A client IP only as an HMAC under the log key, on the events R1 names. No ruling covers an email in a log, so none is logged. | Only the log-key variant, never the stored value.                                                                                                                                        | Yes, when the field is on the event allowlist.                                                                |
| **In an export**           | Never.                                                                                                                                    | Only to the signed-in owner, in their own export.                                                          | Only to the owner. The partial account identifier is excluded.                                                                                | Never.                                                                                                                                                                                   | As far as a restore needs.                                                                                    |
| **Sent to the model**      | Never.                                                                                                                                    | Only the fields of the prompt payload below, aggregated. Labels only after opt-in and `anonymizeMerchant`. | Never.                                                                                                                                        | Never.                                                                                                                                                                                   | Never. Identifier keys are refused at run time.                                                               |
| **Sent to the bank API**   | The application's signed token, the one-time authorisation code and the `state`.                                                          | The chosen bank's name and country, and the date range of a fetch.                                         | Only the identifiers the bank issued (provider account id, session id), in the request path, because the bank needs them.                     | Never.                                                                                                                                                                                   | Only what the request below names (`country`, `valid_until`, `redirect_url`, `psu_type`, `continuation_key`). |
| **After account deletion** | Deleted with the account, in the same transaction, including the tokens of invitations it created. A bank consent is revoked at the bank. | Deleted with the account, in the same transaction.                                                         | Deleted with the account.                                                                                                                     | Deleted with the account, or purged within the retention window.                                                                                                                         | Deleted with its parent row.                                                                                  |

R1, in the `Personal` log cell, is the owner's ruling on [#841](https://github.com/NonoHM/budgetpilot/issues/841#issuecomment-5931570298):
the client IP is logged only as an HMAC under the log-only key, never raw and never truncated,
and only on authentication events and on the rate limiter's refusal of an authentication kind
(`LOGIN`, `MFA`, `REAUTH`, `REGISTER`, `INVITE`). The log key is derived by HKDF-SHA256 from
`RATE_LIMIT_HASH_SECRET` under the label `budgetpilot:log-pseudonym:v1` (R9), so a logged hash
never equals a stored `LoginAttempt.ipHash`. Whoever holds `.env` can still reverse a logged
IPv4 address by enumeration. The protection is against every other reader of the log. The
derivation exists (`src/lib/server/logging/pseudonym.ts`); no event carries an address yet,
because no authentication event is written yet (#250). No stored security event exists (see the
gaps).

### Stated exceptions to the transport rule

Each is an operator choice or a protocol fact, recorded here so that none passes silently.

- `PUBLIC_INSTANCE=false` serves the whole application over plain http and drops the Secure flag
  from the session cookie. It is meant for a LAN instance, and the application prints a warning at
  boot (`src/hooks.server.ts`).
- The prompt travels over plain http to `localhost`, `127.0.0.1`, `[::1]` and `host.docker.internal`,
  and to any host added to `LLM_HTTP_PERMITTED_HOSTS`. Every other allowlisted host must use https
  (`getLocalBaseUrl`, `src/lib/server/insights/local-llm.ts`).
- The bank consent callback carries the one-time `code` and the `state` in its query string, as an
  OAuth-style flow does (`src/routes/imports/bank-connections/callback/+server.ts`). The application
  never logs them, and `Caddyfile.example` deletes both from the proxy access log.
- The invitation token travels in a query string (#825).

## What the code does today

Each statement was read in the file named.

**Secret.**

- Passwords: bcrypt, cost 12 by default, at most 15 (`src/lib/server/auth.ts`, `PASSWORD_COST`).
  Recovery codes use the same function (`src/lib/server/auth/totp.ts`, `hashRecoveryCode`).
- Session, pending-MFA and invitation tokens: 32 random bytes, stored as SHA-256
  (`createSessionToken`, `hashSessionToken` in `auth.ts`; `createMfaChallenge` in
  `src/lib/server/auth/mfaChallenge.ts`).
- Two-factor secrets and bank credentials: AES-256-GCM, 12-byte random IV, key from
  `TOTP_ENCRYPTION_KEY` (`src/lib/server/crypto.ts`). The bank authorisation `state` is stored
  hashed and encrypted (`BankAuthorizationRequest`, model comment in `prisma/schema.prisma`).
- The Enable Banking connector sets `credentialsEncrypted` to null on purpose, because its
  authentication is the application's own key held in the environment
  (`src/lib/server/banking/connectors/enablebanking.ts`, `completeAuthorization`). The session
  identifier the bank returns, `BankConnection.providerSessionId`, is stored as received and is
  classified Personal: it names this person's consent at the bank, and the connector's comment is
  that the session carries no per-connection secret.
- The two cookies the authentication code sets carry Secret tokens: `budgetpilot_session`
  (`auth.ts`) and the pending-MFA cookie (`mfaChallenge.ts`).
- The ciphertexts are authenticated by the GCM tag, and are not bound to their row or column
  (#837).

**Financial and Personal.**

- No column is encrypted by the application. `docs/operations.md` states that `TOTP_ENCRYPTION_KEY`
  encrypts "two things at rest", the two-factor secrets and the bank credentials, and no
  document says that the other columns are stored in clear or that protecting the volume is the
  operator's job. That absence is a gap, filed as #850 in the table below.
- Transport: the session cookie is `httpOnly` and `sameSite: lax` (`auth.ts`), Secure unless
  `PUBLIC_INSTANCE=false`, and `Strict-Transport-Security` is sent with that same condition
  (`src/hooks.server.ts`). A remote database connects in clear unless the URL carries a TLS
  parameter, and `docs/database-providers.md` tells the operator to add one (#251).
- Amounts are integer minor units with a stored currency and exponent per row
  (`prisma/schema.prisma`, model comments on `Transaction`).
- The partial account identifier: at most four characters, shown as `···4417`, excluded from the
  backup because the backup is plaintext (`Account.discriminant` and `RememberedAccount.fragment`
  model comments; `src/lib/server/backup/export.ts` selects neither). Its key in
  `RememberedAccount` is an HMAC (`src/lib/server/import/accountMemoryKey.ts`).

**Pseudonymous.**

- `LoginAttempt.emailHash` and `ipHash` are HMAC-SHA256 under `RATE_LIMIT_HASH_SECRET`
  (`hashRateLimitKey`, `src/lib/server/auth/rateLimit.ts`). `emailHash` is not always an email:
  for the `REAUTH`, `IMPORT` and `BANK_SYNC_START` kinds it holds an HMAC of the user id, and for
  `MFA` an HMAC of a challenge id (#833 tabulates this).
- Rows older than four rate-limit windows (60 minutes) are deleted, but only as a side effect of
  recording a later attempt (`recordAttempt`, `rateLimit.ts`).

**Operational.** No rule is broken by the code that was read. The rows linked to a user are
covered by the retention and deletion gaps below.

**Logs.** Every line is written by `src/lib/server/logging` as one JSON object on stdout, from a
closed type of events whose fields each carry a level from this page ([Logs](../logging.md)).
`boot.mjs`, the container's start command (`CMD ["boot.mjs"]` in the `Dockerfile`), writes through
the same writer's core. It also runs `prisma migrate deploy` with `stdio: 'inherit'`, so that
tool's own output reaches the same stream and the application does not filter it (#846). An
unexpected error is written as its class name and a short code, and its message only when it is an
`OperatorFacingError` (`loggableError`, `src/lib/server/errors.ts`). No event declares a Secret,
Financial or Personal field. `e2e/log-secret-scan.spec.ts`
scans a built server's log for planted values: the configured secrets, the Enable Banking private
key, and the secrets a run mints, which are the session tokens, the TOTP secret and recovery codes,
an invitation token, an admin-issued temporary password, and the bank `state`, `code` and signed
token. Its exercised paths include one forced 500 (#835).

**Exports.** The JSON backup and the transaction CSV go only to the signed-in owner, each scoped
by `userId` (`src/routes/settings/export/+server.ts`, `src/routes/transactions/export/+server.ts`).
The backup selects named columns, so a secret column cannot be added by accident
(`src/lib/server/backup/export.ts`), and its schema rejects `credentialsEncrypted` and
`providerSessionId`. The CSV passes every field through a formula guard
(`src/lib/server/csv/formulaGuard.ts`). The backup is plaintext JSON (#834).

**The model.** The payload is built from `TransactionSummary` (`src/lib/server/insights/types.ts`)
and sent only to the host on `LLM_ALLOWED_HOSTS`, `localhost` by default
(`src/lib/server/insights/local-llm.ts`). Nine identifier-shaped keys are refused at run time, and
the same nine are refused at compile time (`KEYS_REFUSED_IN_PROMPT` in `prompt.ts`,
`ForbiddenPromptKey` in `types.ts`). Without opt-in, `largestExpenses` and `recurringPayments`
labels are replaced by a fixed placeholder (`summary.ts`). With opt-in, those two lists carry
labels that already crossed `anonymizeMerchant`. The third list, `flaggedCategoryLabels`, carries
the raw label (`getFlaggedCategoryLabels`, `summary.ts`): the owner ruled that it passes through
`anonymizeMerchant` too (R4), and #819 holds the change.

**Deletion.** There are two doors. `deleteAccount` (`src/routes/settings/+page.server.ts`) and the
admin `deleteUser` (`src/routes/admin/+page.server.ts`) each remove the user's sessions and
transactions and then the user, in one transaction. Every other user-owned model cascades from
`User`, directly or through a parent row (`prisma/schema.prisma`). What survives is in the gaps.

## Gaps

Every row is a requirement above that the code does not yet meet. None is new in the sense of
being unknown: each has an issue.

| Gap                                                                                                                                                                                                                                                                       | Level                       | Issue                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No authentication, authorization or control-bypass event is written: the writer, the field allowlist and the log pseudonym exist, the events do not.                                                                                                                      | Personal, Pseudonymous      | [#250](https://github.com/NonoHM/budgetpilot/issues/250)                                                                                                                     |
| The stored security event table (180 days default, 365 ceiling) does not exist (R2, R8).                                                                                                                                                                                  | Pseudonymous                | #841, the 1.4 event table                                                                                                                                                    |
| Flagged-category labels reach the model without `anonymizeMerchant`.                                                                                                                                                                                                      | Financial                   | [#819](https://github.com/NonoHM/budgetpilot/issues/819)                                                                                                                     |
| Category names, which a user types, reach the model in the default mode, and the AI page says "no names".                                                                                                                                                                 | Financial                   | #851                                                                                                                                                                         |
| The invitation token travels in a URL query string.                                                                                                                                                                                                                       | Secret                      | [#825](https://github.com/NonoHM/budgetpilot/issues/825)                                                                                                                     |
| The proxy access log filter in `Caddyfile.example` deletes only `code`, `state` and `q`. It removes no field, so the client address stays, and it keeps `redirectTo`, `invite`, and the `category`, `from` and `to` parameters the application builds into its own links. | Secret, Financial, Personal | [#838](https://github.com/NonoHM/budgetpilot/issues/838)                                                                                                                     |
| A failing migration at boot may print a user's values.                                                                                                                                                                                                                    | Financial                   | [#846](https://github.com/NonoHM/budgetpilot/issues/846)                                                                                                                     |
| Expired and revoked sessions and invitations are never deleted.                                                                                                                                                                                                           | Secret, Operational         | [#828](https://github.com/NonoHM/budgetpilot/issues/828)                                                                                                                     |
| Account deletion leaves the invitee's email and the login-attempt hashes.                                                                                                                                                                                                 | Personal, Pseudonymous      | [#833](https://github.com/NonoHM/budgetpilot/issues/833)                                                                                                                     |
| Invitations created by a deleted user keep their token hash and stay redeemable until they expire. Used recovery codes and expired bank authorisation requests are kept until a later event removes them.                                                                 | Secret                      | [#855](https://github.com/NonoHM/budgetpilot/issues/855)                                                                                                                     |
| Account or connection deletion never revokes the bank consent.                                                                                                                                                                                                            | Secret                      | [#832](https://github.com/NonoHM/budgetpilot/issues/832)                                                                                                                     |
| The backup is plaintext and the export control does not say so.                                                                                                                                                                                                           | Financial, Personal         | [#834](https://github.com/NonoHM/budgetpilot/issues/834)                                                                                                                     |
| A remote database is not required to use TLS.                                                                                                                                                                                                                             | all                         | [#251](https://github.com/NonoHM/budgetpilot/issues/251)                                                                                                                     |
| No key management policy, one key for two kinds of secret, and ciphertexts not bound to their row.                                                                                                                                                                        | Secret                      | [#827](https://github.com/NonoHM/budgetpilot/issues/827), [#837](https://github.com/NonoHM/budgetpilot/issues/837), [#217](https://github.com/NonoHM/budgetpilot/issues/217) |
| Nothing tells the operator that Financial and Personal columns are stored in clear and that protecting the volume is theirs.                                                                                                                                              | Financial, Personal         | #850                                                                                                                                                                         |
| Nothing fails when a schema column is missing from the classification below.                                                                                                                                                                                              | all                         | #852                                                                                                                                                                         |

### Stricter than the level

| Column                                               | Level     | Stricter rule                                                                                                     |
| ---------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `Account.discriminant`, `RememberedAccount.fragment` | Personal  | Never in a log, an error message, a prompt or a backup. Shown on screen only in the form `···4417`.               |
| `Transaction.metadataJson`                           | Financial | Holds the bank's reference, bank-specific category fields and, for one profile, a balance. Never logged.          |
| `Transaction.notes`, `TransactionSplit.note`         | Financial | Never in a prompt. The split note is absent from the payload by the type of `CategoryAllocation`.                 |
| `BankConnection.providerSessionId`                   | Personal  | Stripped from the backup, and the backup schema rejects it, so a restored connection cannot come back functional. |

## Every stored column, by level

Each column of `prisma/schema.prisma` appears once, under the model that owns it. The count in
brackets is that model's stored columns. Relation fields store nothing and are excluded. An enum
is a column type, so a column typed by an enum is a column.

| Model                           | Secret                                | Financial                                                                                                                                                                                                   | Personal                            | Pseudonymous          | Operational                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User` (15)                     | `passwordHash`, `totpSecretEncrypted` |                                                                                                                                                                                                             | `email`                             |                       | `id`, `role`, `forcePasswordChange`, `defaultsSeededAt`, `defaultRulesSeededAt`, `aiInsightsEnabled`, `aiIncludeLabels`, `totpEnabled`, `totpEnabledAt`, `categoryRenamePromptDismissedAt`, `createdAt`, `updatedAt` |
| `RecoveryCode` (5)              | `codeHash`                            |                                                                                                                                                                                                             |                                     |                       | `id`, `userId`, `usedAt`, `createdAt`                                                                                                                                                                                |
| `PendingMfaChallenge` (5)       | `tokenHash`                           |                                                                                                                                                                                                             |                                     |                       | `id`, `userId`, `expiresAt`, `createdAt`                                                                                                                                                                             |
| `Session` (6)                   | `tokenHash`                           |                                                                                                                                                                                                             |                                     |                       | `id`, `userId`, `expiresAt`, `createdAt`, `revokedAt`                                                                                                                                                                |
| `Invitation` (9)                | `tokenHash`                           |                                                                                                                                                                                                             | `email`                             |                       | `id`, `createdByUserId`, `expiresAt`, `usedAt`, `usedByUserId`, `revokedAt`, `createdAt`                                                                                                                             |
| `Account` (16)                  |                                       | `name`, `currency`, `exponent`, `source`, `nameKey`, `institution`, `providerCashAccountType`                                                                                                               | `providerAccountId`, `discriminant` |                       | `id`, `userId`, `netWorthAccountId`, `bankConnectionId`, `archivedAt`, `createdAt`, `updatedAt`                                                                                                                      |
| `BankConnection` (15)           | `credentialsEncrypted`                | `aspspName`, `aspspCountry`                                                                                                                                                                                 | `providerSessionId`                 |                       | `id`, `userId`, `provider`, `status`, `consentExpiresAt`, `lastSyncAt`, `lastCompleteSyncAt`, `lastSyncStatus`, `lastSyncError`, `createdAt`, `updatedAt`                                                            |
| `BankAuthorizationRequest` (11) | `stateHash`, `stateEncrypted`         | `aspspName`, `aspspCountry`                                                                                                                                                                                 |                                     |                       | `id`, `userId`, `provider`, `renewsConnectionId`, `expiresAt`, `consumedAt`, `createdAt`                                                                                                                             |
| `Category` (7)                  |                                       | `name`, `nameKey`                                                                                                                                                                                           |                                     |                       | `id`, `userId`, `defaultKey`, `createdAt`, `updatedAt`                                                                                                                                                               |
| `Tag` (7)                       |                                       | `name`, `nameKey`                                                                                                                                                                                           |                                     |                       | `id`, `userId`, `colorToken`, `createdAt`, `updatedAt`                                                                                                                                                               |
| `TransactionTag` (3)            |                                       |                                                                                                                                                                                                             |                                     |                       | `transactionId`, `tagId`, `createdAt`                                                                                                                                                                                |
| `TransactionSplit` (8)          |                                       | `amountCents`, `note`                                                                                                                                                                                       |                                     |                       | `id`, `transactionId`, `categoryId`, `position`, `createdAt`, `updatedAt`                                                                                                                                            |
| `Transaction` (22)              |                                       | `date`, `label`, `amountCents`, `currency`, `exponent`, `type`, `source`, `notes`, `bankOperationType`, `manualCategory`, `manualCategoryKey`, `natureManual`, `dedupeKey`, `dedupeKeyHash`, `metadataJson` |                                     |                       | `id`, `userId`, `accountId`, `categoryId`, `importBatchId`, `createdAt`, `updatedAt`                                                                                                                                 |
| `ImportBatch` (16)              |                                       | `source`, `fileName`, `profile`, `rowCount`, `importedRows`, `duplicateRows`, `invalidRows`, `periodStart`, `periodEnd`                                                                                     |                                     |                       | `id`, `userId`, `accountId`, `columnMappingId`, `dateOrder`, `createdAt`, `updatedAt`                                                                                                                                |
| `ColumnMapping` (17)            |                                       | `fingerprint`, `dateColumn`, `labelColumn`, `amountColumn`, `categoryColumn`                                                                                                                                |                                     |                       | `id`, `userId`, `matchBy`, `dateIndex`, `labelIndex`, `amountIndex`, `categoryIndex`, `columnCount`, `useCount`, `lastUsedAt`, `createdAt`, `updatedAt`                                                              |
| `RememberedAccount` (7)         |                                       |                                                                                                                                                                                                             | `fragment`                          | `identifierKey`       | `id`, `userId`, `accountId`, `useCount`, `rememberedAt`                                                                                                                                                              |
| `CategorizationRule` (8)        |                                       | `pattern`, `targetCategory`, `type`                                                                                                                                                                         |                                     |                       | `id`, `userId`, `active`, `createdAt`, `updatedAt`                                                                                                                                                                   |
| `CategoryRule` (11)             |                                       | `name`, `matchText`, `targetCategory`, `targetNature`                                                                                                                                                       |                                     |                       | `id`, `userId`, `isRegex`, `enabled`, `defaultRuleKey`, `createdAt`, `updatedAt`                                                                                                                                     |
| `MonthlyBudget` (9)             |                                       | `categoryName`, `categoryNameKey`, `amountCents`, `currency`, `exponent`                                                                                                                                    |                                     |                       | `id`, `userId`, `createdAt`, `updatedAt`                                                                                                                                                                             |
| `LoginAttempt` (5)              |                                       |                                                                                                                                                                                                             |                                     | `emailHash`, `ipHash` | `id`, `kind`, `createdAt`                                                                                                                                                                                            |
| `CategoryNatureMapping` (7)     |                                       | `categoryName`, `categoryNameKey`, `nature`                                                                                                                                                                 |                                     |                       | `id`, `userId`, `createdAt`, `updatedAt`                                                                                                                                                                             |
| `NetWorthAccount` (11)          |                                       | `name`, `type`, `balanceCents`, `currency`, `exponent`, `nameKey`                                                                                                                                           |                                     |                       | `id`, `userId`, `deletedAt`, `createdAt`, `updatedAt`                                                                                                                                                                |
| `NetWorthSnapshot` (8)          |                                       | `type`, `balanceCents`, `currency`, `exponent`, `capturedAt`                                                                                                                                                |                                     |                       | `id`, `userId`, `accountId`                                                                                                                                                                                          |
| `SavingsGoal` (15)              |                                       | `name`, `targetAmountCents`, `currentAmountCents`, `startingBalanceCents`, `currency`, `exponent`, `targetDate`, `reachedAt`                                                                                |                                     |                       | `id`, `userId`, `netWorthAccountId`, `reachedBannerDismissedAt`, `deletedAt`, `createdAt`, `updatedAt`                                                                                                               |
| `RecurringStreamAction` (10)    |                                       | `direction`, `normalizedLabel`, `label`, `dueDate`                                                                                                                                                          |                                     |                       | `id`, `userId`, `kind`, `anchorTransactionIds`, `createdAt`, `updatedAt`                                                                                                                                             |

Six readings the table needs.

- **`ColumnMapping` header cells and fingerprint are Financial.** The model comment calls the
  four `*Column` values "cells from a user's file" and bounds them because they are rendered, so they
  can hold any text the file did. The fingerprint is an unkeyed hash of the header row, which rule 1
  gives the level of its source. The other columns describe a mapping's shape and are Operational.
- **`Account.providerCashAccountType` is Financial.** Its values (`LOAN`, `CARD`, `SVGS`) say what
  the user owns or owes, which is the Financial test.
- **`Account.source` is Financial, like `Transaction.source` and `ImportBatch.source`.** All three
  name the channel a statement or an account came from.
- **`BankConnection.providerSessionId` is Personal, like `providerAccountId`.** It is an identifier
  the bank issued for this person's consent, and it grants nothing without the application's own
  private key.
- **`ImportBatch` row counts and period are Financial.** A count unusual enough to fingerprint a
  file identifies the statement it came from (AGENTS.md, "Never publish anything derived from a
  real statement").
- **`Transaction.dedupeKey` is Financial, and so is its hash.** The key is a `|`-joined
  fingerprint of date, label, amount, type, reference and account id
  (`src/lib/server/import/dedupeKey.ts`), and the hash is an unkeyed SHA-256 of it.

## Fields that are not columns

### What reaches the model

The prompt carries 32 leaf fields, counted in `TransactionSummary` and the types it names
(`src/lib/server/insights/types.ts`, `src/lib/server/reports/monthly.ts`,
`src/lib/domain/allocation.ts`), plus the fixed system prompt in `prompt.ts`. Monetary fields lose
their `Cents` suffix on the way out (`toPromptPayload`).

| Group                         | Fields                                                                                                                                                                | Level     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Envelope (6)                  | `currency`, `period`, `income`, `expense`, `balance`, `transactionCount`                                                                                              | Financial |
| `topCategories[]` (4)         | `category`, `amount`, `transactionCount`, `percentageOfExpenses`                                                                                                      | Financial |
| `largestExpenses[]` (9)       | `label`, `amount`, `category`, and the split indicator: `dominantCategory`, `dominantNature`, `otherCategoryCount`, `partCount`, `parts[].category`, `parts[].amount` | Financial |
| `recurringPayments[]` (7)     | `label`, `amount`, `totalAmount`, `count`, `category`, `lastDate`, `confidence`                                                                                       | Financial |
| `previousMonth` (4)           | `month`, `incomeDelta`, `expenseDelta`, `balanceDelta`                                                                                                                | Financial |
| `flaggedCategoryLabels[]` (2) | `category`, `labels`                                                                                                                                                  | Financial |

Besides the payload, each request sends the model name, the fixed system prompt, a JSON schema for
the reply and two options (`src/lib/server/insights/local-llm.ts`), and a reachability probe to
`/api/version`. `label` is the placeholder `Expense` or `Recurring payment` unless the user opted in.
No Secret, Personal, Pseudonymous or Operational column is in the payload.

### What reaches an export

| Export                                                                                         | Fields                                                                                                                                                                         | Levels                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Transaction CSV, `/transactions/export` (11)                                                   | `date`, `libelle`, `categorie`, `montant`, `type`, `nature`, `source_bancaire`, `montant_total`, `part`, `categorie_parent`, `compte`                                          | Financial                        |
| Backup JSON, `/settings/export` (122 columns, plus `userEmail`, `formatVersion`, `exportedAt`) | The named `select` of each model in `src/lib/server/backup/export.ts`, including `Transaction.metadataJson` and `dedupeKey`, `Account.providerAccountId` and the owner's email | Financial, Personal, Operational |

The backup selects no Secret and no Pseudonymous column, and no partial account identifier. It
omits `LoginAttempt` and `RememberedAccount` entirely.

### What reaches a log

Every line is written by one module, `src/lib/server/logging`, as a member of a closed type of
events, and [Logs](../logging.md) lists each event with each field and the level from this page.
The type admits only Operational, Pseudonymous and, for one field, not classified, so a Secret,
Financial or Personal field cannot be declared. The 51 `console.*` call sites in 21 files this page counted on the
commit that introduced it were each replaced by an event, and a lint rule in `eslint.config.js`
refuses a new one under `src/lib/server`, `src/routes` and `src/hooks.server.ts`.

| Source                                                                               | What the events carry                                                                                                          | Level          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| The envelope of every line                                                           | time, severity, event name, a fixed sentence, the schema version, a process id, a sequence number and the previous line's hash | Operational    |
| A request (`handleLogContext`, `src/hooks.server.ts`)                                | a server-generated request id, the method, the matched route template, never the path                                          | Operational    |
| Request errors (`handleError`)                                                       | status, the error id the page shows, error class and code                                                                      | Operational    |
| Fatal errors (`lastResortErrors.ts`)                                                 | the origin, error class and code                                                                                               | Operational    |
| Startup (`src/hooks.server.ts`)                                                      | the security-relevant configuration as closed values, and the configured `ORIGIN`                                              | Operational    |
| Boot backfills, the lock wait, configuration bounds, the database role warning       | names from a closed set, counts, booleans, the name and value of an operator-set bound                                         | Operational    |
| Request-time warnings (import, transactions, bank sync)                              | closed reasons, an error class, a connection id, an HTTP status and a provider code admitted only in the shape of a code       | Operational    |
| The container start (`boot.mjs`, through the writer's core)                          | the SQLite data directory from `DATABASE_URL`, the uid, a filesystem error code, an exit code                                  | Operational    |
| What a dependency prints (`budgetpilot.console.text`)                                | the text, capped at 256 characters and escaped                                                                                 | not classified |
| The output of `prisma migrate deploy`, which `boot.mjs` runs with `stdio: 'inherit'` | whatever that tool prints, unfiltered by the application (#846)                                                                | not classified |

An `OperatorFacingError` also carries its message, which is text the application wrote for the
operator (`loggableError`). The configured `ORIGIN` is the operator's own URL. The dependency text is
the one field whose content the application does not choose: adapter-node's « Listening on » line is
the measured instance, and our own code cannot reach it because the lint rule forbids `console`.
Rule 2 gives free text the level of what it is about, and nobody knows what a dependency will
print, so this page cannot classify it, any more than the last row, which is what #846 is about.

### What reaches another host

The sweep for outbound HTTP found two production callers of `fetchWithRedirectGuard`
(`src/lib/server/net/redirectGuard.ts`) and three call sites: the Enable Banking client
(`src/lib/server/banking/enablebanking/http.ts`) and, in `local-llm.ts`, the reachability probe and
the Ollama client. Both refuse a host that is not on their allowlist and a redirect to one
(`BANK_SYNC_ALLOWED_HOSTS`, `LLM_ALLOWED_HOSTS`). The three client-side `fetch` calls (`src/lib/import/createAccountRequest.ts`,
`src/routes/import/+page.svelte`, `src/routes/import/columns/+page.svelte`) post to the
application's own origin.

| Destination    | Request                           | Fields sent                                                                                             | Levels                           |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Enable Banking | `GET /aspsps`                     | `country`                                                                                               | Operational                      |
| Enable Banking | `POST /auth`                      | `valid_until`, the bank's `name` and `country`, a random `state`, `redirect_url`, `psu_type`            | Financial, Secret, Operational   |
| Enable Banking | `POST /sessions`                  | the one-time authorisation `code`                                                                       | Secret                           |
| Enable Banking | `GET /sessions/{id}`              | the session id, in the path                                                                             | Personal                         |
| Enable Banking | `GET /accounts/{id}/transactions` | the provider account id in the path, `date_from`, `date_to`, `continuation_key`                         | Personal, Financial, Operational |
| Enable Banking | `GET /accounts/{id}/balances`     | the provider account id, in the path                                                                    | Personal                         |
| Enable Banking | every request                     | `Authorization: Bearer`, an RS256 JWT signed by the application with `kid`, `iss`, `aud`, `iat`, `exp`  | Secret                           |
| Ollama         | `GET /api/version`                | nothing: no body and no query string                                                                    | none                             |
| Ollama         | `POST /api/chat`                  | the prompt payload above, the model name, the JSON schema of the reply, `temperature` and `num_predict` | Financial, Operational           |

The Enable Banking requests carry Secret values the application or the bank issued for the flow
(the signed token, the code and the `state`), Personal identifiers the bank issued (the session id
and the provider account id, in the request path, because the bank needs them), and Financial data
only in the form of the chosen bank's name and country and a date range. No Financial column is
sent. The responses carry the bank's own transactions, which the application writes into Financial
columns.

## The law, and what this page does about it

The classification is written on the assumption that the instance operator is a controller. Under
that assumption the Regulation requires data minimisation, and the classification is how the code is
held to it. Three provisions of Regulation (EU) 2016/679, quoted from the Official
Journal text (L 119, 4.5.2016, `https://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.03/DOC_1`,
read 2026-10-02):

- Article 5(1)(c): personal data shall be "adequate, relevant and limited to what is necessary in
  relation to the purposes for which they are processed (‘data minimisation’)". This is why the
  prompt has a field list and not a record, and why the log levels above say "never" for
  Financial and Personal.
- Article 5(1)(e): personal data shall be "kept in a form which permits identification of data
  subjects for no longer than is necessary for the purposes for which the personal data are
  processed". This is why retention and deletion are rows of the requirements table, and why
  #828 and #833 are gaps and not housekeeping.
- Article 4(5): pseudonymisation is processing "in such a manner that the personal data can no
  longer be attributed to a specific data subject without the use of additional information,
  provided that such additional information is kept separately and is subject to technical and
  organisational measures". The Pseudonymous level means this only while the HMAC key is kept
  outside the database. On a single host that separation rests on file permissions, and
  whoever holds `.env` can reverse an IPv4 address by enumeration.

Article 25(2) adds that "by default, only personal data which are necessary for each specific
purpose of the processing are processed", and that the obligation applies to "the amount of
personal data collected, the extent of their processing, the period of their storage and their
accessibility". The opt-in for labels (`User.aiIncludeLabels`, default false, `prisma/schema.prisma`)
is that default.

For logs, the CNIL's recommendation on logging (Deliberation 2021-122 of 14 October 2021,
`https://www.cnil.fr/sites/default/files/atoms/files/recommandation_-_journalisation.pdf`, read
2026-10-02) is the source of two rulings recorded on #841. Paragraph 8: "La Commission
recommande de conserver ces données pendant une durée comprise entre six mois et un an." Paragraph
13: "Les utilisateurs habilités à accéder au traitement doivent être informés de la mise en place
du dispositif de journalisation, de la nature des données collectées et de la durée de
conservation de ces dernières." The first is why the stored event table is bounded at 180 days by
default and 365 at most. The second is why a notice page for security logging is part of the
logger work. Both are recommendations, and the page says what they recommend and not that they
are binding.

What this page does not decide: whether a household instance's operator is a controller within the
meaning of the Regulation. The page is written to hold if the answer is yes.

## What this page contributes to, and what it does not

`ASVS v5.0.0-14.1.1` (Level 2): "Verify that all sensitive data created and processed by the
application has been identified and classified into protection levels. This includes data that is
only encoded and therefore easily decoded, such as Base64 strings or the plaintext payload inside a
JWT. Protection levels need to take into account any data protection and privacy regulations and
standards which the application is required to comply with."

**This page contributes to the requirement and does not satisfy it.** All 253 stored columns are
classified, and the prompt, export, log and outbound fields are classified beside them. The one
encoded payload that carries claims is the signed JWT sent to Enable Banking, whose header and
claims are in the table above. The regulation is named. Two things are missing for the row to move:
a search for other encoded values, such as Base64 strings or token payloads, which was not made,
and a gate that keeps the classification in step with the schema (#852).

`ASVS v5.0.0-14.1.2` (Level 2): "Verify that all sensitive data protection levels have a documented
set of protection requirements. This must include (but not be limited to) requirements related to
general encryption, integrity verification, retention, how the data is to be logged, access controls
around sensitive data in logs, database-level encryption, privacy and privacy-enhancing technologies
to be used, and other confidentiality requirements."

**The requirements are documented in part, and several are not met in code. The row does not
move.** "Access controls around sensitive data in logs" is the missing rule: this page states no
access requirement for the log, because stdout is whatever the operator's container runtime keeps,
and the stored event table that would carry an application rule does not exist (#250, 1.4). The
gaps table is the list of what is documented and not yet true.

`ASVS v5.0.0-14.2.4` (Level 2): "Verify that controls around sensitive data related to encryption,
integrity verification, retention, how the data is to be logged, access controls around sensitive
data in logs, privacy and privacy-enhancing technologies, are implemented as defined in the
documentation for the specific data's protection level." Now that a definition exists it can be
checked against, and it is not met: the gaps table is the measurement.

## Re-deriving the figures

The stored column count (253 over 25 models), from the repository root:

```bash
awk 'NR==FNR{if($1=="model")M[$2]=1;next} $1=="model"{m=1;next} /^}/{m=0} m&&NF>=2&&$1!~/^(\/\/|@@)/{t=$2;gsub(/[?\[\]]/,"",t); if(!(t in M))n++} END{print n}' prisma/schema.prisma prisma/schema.prisma
grep -c '^model ' prisma/schema.prisma
```

The log call sites, with the number of files read, from the repository root:

```bash
git ls-files -z src boot.mjs | grep -zEv 'paraglide|generated|\.spec\.|db-smoke|sandbox-validation|\.svelte$' | xargs -0 grep -cE '^[^/*]*console\.(log|warn|error|info|debug)\(' | awk -F: '{r++; if($2>0){f++; s+=$2}} END{print r" files read, "s" call sites in "f" files"}'
```

It prints `268 files read, 51 call sites in 21 files` on the commit that introduced this page, and
`0 call sites` once the logger replaced them (#250); the lint rule in `eslint.config.js` is what
keeps it there. The pattern skips a line that has `/` or `*` before `console`, so a comment naming
the call is not counted. The other figures are counts over named files and are re-derived by reading them: the
payload types for the 32 prompt fields, and the `select` blocks of
`src/lib/server/backup/export.ts` for the 122 exported columns.

If you run an instance, the operator's page is [operations](../operations.md): the encryption key,
backups, upgrades and what to keep out of the same archive.
