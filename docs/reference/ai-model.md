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
| Lists the model on `/api/tags`, locally  | Read before and after every generation, for the model's digest and format. See « Refusals before a generation ».    |
| Answers within a byte bound              | The connection stops reading at a bound derived from the caller's schema. See « How much the connection reads ».    |

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
because `npm run setup:llm` pulls it and the Compose overlay names it as the
default, and because the next caller starts from a known build rather than from
a tag. The full digest
is in `src/lib/server/ai/qualification/qualified-model.json`, the one place the
default is written; `qualifiedModel.spec.ts` holds every copy of the tag to it.

The weekly re-qualification and `npm run ai:check` were removed with the
advice. A qualification belongs to a task, and the next caller defines a new
one.

## Pinning the model by digest

`LLM_MODEL` names a model by tag, and a tag is a pointer that a later pull can
move. `BP_LLM_MODEL_DIGEST` pins the model itself: with it set, the connection
refuses to generate with any model whose digest differs, even under the same
name. It is optional and unset by default.

The value is the full digest, 64 lowercase hexadecimal characters. Any other
value stops the app at start with a message naming the variable. `ollama list`
prints only the first 12 characters, so read the whole digest one of these
ways:

- With the AI overlay, from the directory holding `.env`:

  ```bash
  docker compose exec ollama sha256sum /var/lib/ollama/.ollama/models/manifests/registry.ollama.ai/library/phi4-mini/3.8b
  ```

  Replace `phi4-mini/3.8b` with your model's name and tag, separated by `/`.
  The first word printed is the digest.

- With Ollama on the same machine as the app:

  ```bash
  curl -s http://127.0.0.1:11434/api/tags | jq -r '.models[] | "\(.digest) \(.name)"'
  ```

Both print the same value: on Ollama 0.32.5 the digest `/api/tags` lists is the
SHA-256 of the model's manifest file. Write it in `.env` as
`BP_LLM_MODEL_DIGEST=<digest>`, then run `docker compose up -d`, because
`docker compose restart` does not read an edited `.env`.

After a pull you meant to make, read the digest again and update the line. Until
you do, every generation is refused as `model_mismatch`, which is the pin doing
its job.

**The pin detects a swap. It does not authenticate the model server.** The
digest is the one the server reports about itself, so a hostile server can
report the pinned value. What it catches is an accidental or unreviewed pull
under the same tag. No model signatures exist upstream to check instead.

## Refusals before a generation

Every generation first asks the model server which model it would use, on
`/api/tags`, within the connect budget (`LLM_CONNECT_TIMEOUT_MS`). Each of these
is refused before the model is asked anything:

| Code                 | When                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `model_unavailable`  | The server does not list `LLM_MODEL`. Names compare as Ollama prints them: `library/` dropped, `:latest` added to a name with no tag. |
| `model_remote`       | The server lists the model as forwarded to another machine, as an Ollama `-cloud` tag is: the prompt would leave for ollama.com.      |
| `model_unidentified` | The list cannot be read: larger than 1 MiB, not JSON, or a digest that is not 64 hexadecimal characters.                              |
| `model_mismatch`     | `BP_LLM_MODEL_DIGEST` is set and the listed digest differs.                                                                           |

The list is read again after the answer. If the digest changed while the model
was generating, the answer is refused as `model_mismatch`.

## Halting every model call

An administrator halts and resumes every member's model calls from the admin
page ([Halting AI for everyone](../using/admin.md#halting-ai-for-everyone)),
with no restart. While halted, the connection answers `halted`:

| When the halt lands                                           | What the connection does                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Before a call starts                                          | Refuses it before opening any socket. Marked as no work done.                                |
| During the probe or the model list read before the generation | Aborts the request in progress. Marked as no work done.                                      |
| During the generation, or the model list read after it        | Aborts the request in progress and withholds any answer. Counted as work, since it was sent. |

`probeLocalLlm` answers `halted` too, so a caller that checks reachability
before serving something it kept is told the same thing.

- **Stored.** The halt is one row in the `InferenceHalt` table: when it was set
  and by which account. It survives a restart. Deleting that account keeps the
  halt and clears the account.
- **Read on every call.** A read of that row that fails refuses the call, so
  an unreachable database does not lift the halt.
- **Independent of `LLM_ENABLED`.** A call runs only when `LLM_ENABLED=true`
  and no halt is set. `LLM_ENABLED` is read at each call from the environment,
  so changing it needs a restart; the halt does not.
- **Logged.** `budgetpilot.ai.inference_halted` and
  `budgetpilot.ai.inference_resumed`, both at `WARN` and neither a security
  event, so no value of `BP_LOG_LEVEL` or `BP_SECURITY_LOG` drops them
  ([log events](../logging.md#budgetpilotaiinference_halted)). A second halt
  while halted writes nothing; a resume refused for a wrong password writes
  `budgetpilot.authn.reauth_fail` instead.

## How much the connection reads

The connection stops reading an answer at a bound it derives from the caller's
schema, and refuses the answer as `response_unusable` once the server sends
more. Before [#967](https://github.com/NonoHM/budgetpilot/issues/967), a test
server's 64 MiB answer was read to its last byte. The bound allows for the
longest answer the schema admits, for the whitespace the model's grammar lets it
add, and for the server's escaping of every character, so an honest answer is
never cut. The model list is bounded at 1 MiB: one entry measured 410 bytes on
Ollama 0.32.5, so about 2500 models fit. The probe on `/api/version` that opens
each generation reads no body.

## A model server on another machine

At start, the app writes a `budgetpilot.config.model_host_remote` warning when
the host in `LLM_BASE_URL` is not on this machine, while `LLM_ENABLED=true`. The
connection follows no redirect from the model server, so no other host receives
anything. A host counts as this machine when it is `localhost`, `127.0.0.1`, `[::1]`,
`host.docker.internal`, or a name without a dot listed in
`LLM_HTTP_PERMITTED_HOSTS`, which is how the AI overlay declares its `ollama`
container. The overlay therefore writes no warning. An address or a dotted name
is reported even when it is listed there.

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

Once your models are downloaded, `docker-compose.ai.offline.yml` cuts Ollama
off from the internet. The app still reaches it, and models already downloaded
keep answering; only `ollama pull` stops working while the file is in use.

Every command below is a plain `docker compose`, reading your list of Compose
files from the `COMPOSE_FILE` line in `.env`. If you have not written that line
yet, see « Before you start » under
[Before you upgrade to 1.3.0](../operations.md#before-you-upgrade-to-130); on
the prebuilt image it reads, for example:

```dotenv
COMPOSE_FILE=docker-compose.prebuilt.yml:docker-compose.ai.yml
```

1. Download the models you need, if you have not already. The default is the
   one `LLM_MODEL` names, `phi4-mini:3.8b` unless you changed it:

   ```bash
   docker compose exec ollama ollama pull phi4-mini:3.8b
   ```

2. On the prebuilt image, download the offline file next to your other Compose
   files (a source checkout already has it):

   ```bash
   curl -fO https://raw.githubusercontent.com/NonoHM/budgetpilot/main/docker-compose.ai.offline.yml
   ```

3. Add `:docker-compose.ai.offline.yml` at the end of the `COMPOSE_FILE` line
   in `.env`, then start the stack again:

   ```bash
   docker compose up -d
   ```

4. Check that Ollama is offline by asking it for a model that does not exist:

   ```bash
   docker compose exec ollama ollama pull budgetpilot-offline-check
   ```

   Offline, the error names a failed lookup:
   `lookup registry.ollama.ai ... server misbehaving`. If it says
   `file does not exist` instead, Ollama reached the internet: check the
   `COMPOSE_FILE` line, then run `docker compose down` and
   `docker compose up -d`, and check again. If the command cannot reach Ollama
   at all, `docker compose ps` shows whether it is running.

To download another model later, remove `:docker-compose.ai.offline.yml` from
the line, run `docker compose up -d`, pull the model, then put the file back,
run `docker compose up -d`, and repeat the check in step 4.

## Checking whether a model reasons

Once a model is pulled, Ollama reports what it can do:

```bash
docker compose exec ollama ollama show phi4-mini:3.8b
```

(This reads your files from the `COMPOSE_FILE` line in `.env`, as above.)

A `thinking` capability means the model reasons, and the connection sends
`think: false` to switch it off. The absence of one means there was nothing to
switch off.

## What this does not promise

- **No feature, and no measurement of one.** The connection is a part: nothing
  here says a model answers well, only how the connection asks and what it
  refuses.
- **Nothing about a model that ignores `think: false`.** No model measured here
  does. One that did would reason anyway and could overrun the caller's
  ceiling, and its reasoning text would count against the read bound, so its
  answer would likely be refused as `response_unusable`.
- **No host check beyond the allowlist.** `LLM_ALLOWED_HOSTS` and
  `LLM_HTTP_PERMITTED_HOSTS` decide where the connection may go, and the
  connection follows no redirect. They do not authenticate the model server,
  and neither does the digest pin.
- **No format allow-list and no scan of a pulled model.** The connection reads
  the format the server lists (`gguf` on 0.32.5) and refuses none
  ([#1032](https://github.com/NonoHM/budgetpilot/issues/1032)).
- **A halt reaches one server process.** A call already running is aborted in
  the process that received the halt. The app runs as one process, so that is
  every call; a second process would refuse its next call and not abort its
  running one.
- **No measurement that Ollama stops generating on an abort.** The connection
  closes its request, which a test server sees. Whether Ollama then stops the
  generation on its side was not measured.
- **No warning for a machine named without a dot.** A host listed in
  `LLM_HTTP_PERMITTED_HOSTS` with a single-label name is taken to be a container
  on this machine.

## Related

- [Configuration reference](../configuration-reference.md#ai-connection), for
  every setting of the connection with its accepted values.
- [AISVS map of the AI path](./aisvs-map.md), for what each AISVS requirement
  reads in a release with no AI use.
