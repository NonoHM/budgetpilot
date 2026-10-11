# The local model connection

For operators and security reviewers. Members have nothing to set up: see
[your account and settings](../using/account.md).

BudgetPilot 1.3 makes **no call to a model**. The dashboard's AI advice was
removed ([#1010](https://github.com/NonoHM/budgetpilot/issues/1010)), and the
decision record says why and what comes next
([#1009](https://github.com/NonoHM/budgetpilot/issues/1009)). The rule-based
Insights card on the dashboard never used a model and is unchanged.

What stays is the connection to a local Ollama, as a part with no caller: its
settings, its host allowlist and the model pin. This page describes that part,
for an operator reading an `.env` and for a reviewer checking what the
repository still holds.

## What an operator sees

- **Settings.** Every `LLM_*` and `BP_LLM_*` setting is still accepted and
  still checked at start, so an `.env` written for 1.2 starts 1.3 the same way.
  None of them changes anything a member sees. The
  [configuration reference](../configuration-reference.md#ai-connection) lists
  them, each marked as read by no feature in 1.3.
- **Settings page.** The AI switches and the « Local AI » status are gone.
- **Database.** The two columns that held each member's AI switches stay, read
  by nothing, so the 1.2 image still finds them after a rollback. The first
  change of 1.4 drops them
  ([#1011](https://github.com/NonoHM/budgetpilot/issues/1011)).
- **Compose overlay.** `docker-compose.ai.yml` still starts an Ollama service
  and turns the connection on. In 1.3 nothing asks that service anything, so
  there is no reason to add the overlay.

## What the connection asks of a model

The requirements a caller inherits. Each is a property of the code in
`src/lib/server/insights/local-llm.ts`, not of a model.

| Requirement                              | What the connection does about it                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Answers over `/api/chat` on Ollama       | `LLM_PROVIDER` accepts `ollama` and nothing else.                                                                   |
| Honours a JSON schema passed as `format` | The caller's schema is sent on every request, and the answer is validated against it; anything else is refused.     |
| Fits its answer in the caller's ceiling  | Sent as `num_predict`. The caller derives it from the largest answer its schema admits, never from a chosen number. |
| Suppresses reasoning when told to        | `think: false` is sent on every request, to every model.                                                            |

The ceiling is the caller's because a fixed number outlives the schema it was
sized for: a literal 512 cut every complete answer short until it was replaced
by a derived figure ([#524](https://github.com/NonoHM/budgetpilot/issues/524)).

Reasoning is suppressed because a reasoning model spends its reasoning out of
the same token budget as the answer. Measured on `qwen3.5:4b-q8_0` under Ollama
0.32.5, the same prompt stopped at the ceiling with no answer at all without
`think: false`, and finished in 282 tokens with it
([#527](https://github.com/NonoHM/budgetpilot/issues/527)). An Ollama too old
to know the field ignores it without an error.

## The default model

| Model            | Licence | Digest (first 12) | Ollama | Qualified on |
| ---------------- | ------- | ----------------- | ------ | ------------ |
| `phi4-mini:3.8b` | MIT     | `78fad5d182a7`    | 0.32.5 | 2026-10-10   |

It was qualified for the dashboard advice that 1.3 removed
([#971](https://github.com/NonoHM/budgetpilot/issues/971)). The pin stays
because `npm run setup:llm` and the Compose overlay pull it, and because the
next caller starts from a known build rather than from a tag. The full digest
is in `src/lib/server/ai/qualification/qualified-model.json`, the one place the
default is written; `qualifiedModel.spec.ts` holds every copy of the tag to it.

The weekly re-qualification and `npm run ai:check` were removed with the
advice. A qualification belongs to a task, and the next caller defines a new
one.

## Checking whether a model reasons

Once a model is pulled, Ollama reports what it can do:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
  exec ollama ollama show phi4-mini:3.8b
```

A `thinking` capability means the model reasons, and the connection sends
`think: false` to switch it off. The absence of one means there was nothing to
switch off.

## What this does not promise

- **No feature, and no measurement of one.** The connection is a part: nothing
  here says a model answers well, only how the connection asks and what it
  refuses.
- **Nothing about a model that ignores `think: false`.** No model measured here
  does. One that did would reason anyway and could overrun the caller's
  ceiling.
- **No host check beyond the allowlist.** `LLM_ALLOWED_HOSTS` and
  `LLM_HTTP_PERMITTED_HOSTS` decide where the connection may go, and every
  redirect is checked against the same list. They do not authenticate the
  model server.

## Related

- [Configuration reference](../configuration-reference.md#ai-connection), for
  every setting of the connection with its accepted values.
- [AISVS map of the AI path](./aisvs-map.md), for what each AISVS requirement
  reads in a release with no AI use.
