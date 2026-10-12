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

## The Ollama container

`docker-compose.ai.yml` runs Ollama with the same restrictions as the app
([What the container is allowed to do](../operations.md#what-the-container-is-allowed-to-do)),
plus a fixed user, two bounds and its own networks
([#821](https://github.com/NonoHM/budgetpilot/issues/821)):

| Setting                                   | What it means                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `user: '65532:65532'`                     | Ollama runs as an unprivileged user, not as root                                             |
| `read_only: true`, `tmpfs: [/tmp]`        | It writes only its model volume and `/tmp`                                                   |
| `cap_drop: [ALL]`                         | No Linux capabilities                                                                        |
| `security_opt: [no-new-privileges:true]`  | Nothing inside can gain more privileges than it started with                                 |
| `mem_limit`, from `BP_OLLAMA_MEM_LIMIT`   | The most memory it may use; default `6g`                                                     |
| `pids_limit`, from `BP_OLLAMA_PIDS_LIMIT` | The most processes and threads it may run; default `512`                                     |
| `networks: [ai, ollama_egress]`           | The app reaches it on `ai`; no other container does. `ollama_egress` lets `ollama pull` work |

The model volume is mounted at `/var/lib/ollama/.ollama`. A short service,
`ollama-volume-owner`, runs before Ollama on each `docker compose up`: it hands
any file not yet owned by that user over to it, then exits. It has no network
and only the two capabilities it needs to change an owner.

**Memory.** Measured on the CPU with the default model, `phi4-mini:3.8b`, and
Ollama's default context, 4096 tokens on that host: one answer peaked at 3.3 GB. Under a
2 GB limit the same model was stopped while it loaded, and the request failed
with `llama-server process has terminated: signal: killed`. A larger model
needs a larger `BP_OLLAMA_MEM_LIMIT` in `.env`. The measurement on a GPU, where
the weights sit in the card's memory, was not made.

**Processes.** The same answer peaked at 60 processes and threads on a 16-core
host, the only host measured. If a host with many more cores refuses to start a
model, raise `BP_OLLAMA_PIDS_LIMIT`.

**Who can reach it.** Ollama's API has no authentication. No other container
of the stack shares a network with it except the app: a reverse proxy or a
database container added by the other overlays cannot resolve its name or reach
its address. The host itself can reach its address, as it can any container's.
By default Ollama keeps a route to the internet, through `ollama_egress`, so
that `ollama pull` works as before; `OLLAMA_NO_CLOUD=1` stops the calls it
would otherwise make on its own. To take that route away once your models are
pulled, see [Running Ollama without internet access](#running-ollama-without-internet-access).

To change a bound, set it in `.env` and run `docker compose up -d` again with
the same files. Compose does not check either value: `0` removes the memory
bound and `-1` the process bound, and nothing warns about it
([#1026](https://github.com/NonoHM/budgetpilot/issues/1026)).

## Running Ollama without internet access

Once the models you need are on the volume, `docker-compose.ai.offline.yml`
makes Ollama's internet network internal, so Ollama has no route out of the
stack and its own calls to ollama.com fail. The app still reaches it. The
overlay sets one network key, `internal`, rather than a YAML tag an older
Compose could ignore, and placing it before or after `docker-compose.ai.yml`
gave the same result; these steps put it last, and step 3 checks it worked.

1. With the stack running, pull the models you need, if you have not already:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ai.yml \
     exec ollama ollama pull phi4-mini:3.8b
   ```

2. Add the offline overlay to the command you use, and start the stack again:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ai.yml \
     -f docker-compose.ai.offline.yml up -d
   ```

   On the prebuilt image, use `docker-compose.prebuilt.yml` in place of
   `docker-compose.yml`, and download the overlay next to it first:

   ```bash
   curl -O https://raw.githubusercontent.com/NonoHM/budgetpilot/main/docker-compose.ai.offline.yml
   ```

3. Check that Ollama is offline by asking it for a model that does not exist:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.ai.yml \
     -f docker-compose.ai.offline.yml exec ollama ollama pull budgetpilot-offline-check
   ```

   Offline, the error names a failed lookup: `lookup registry.ollama.ai ...
server misbehaving`. If it says `file does not exist` instead, Ollama reached
   the registry, and the overlay is not in effect.

Models already pulled keep answering. To pull another model, run your usual
command without the overlay, pull, then add it back.

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
