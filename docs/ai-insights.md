# Local AI advice (optional)

BudgetPilot can show a short written commentary on your month next to the
deterministic insights on the dashboard. It runs against a model you host
yourself with [Ollama](https://ollama.com/). No API key, no account, no
external service.

It's off by default and genuinely off: with `LLM_ENABLED=false` the app
makes no network call at all, it doesn't even build a prompt.

## What gets sent to the model

By default, **aggregates only**: totals per category, budget status, the
shape of the month. No transaction labels, no account numbers, no names.

One opt-in switch per user in Settings adds the labels of your largest
expenses, the same ones already shown in the insights above the card. Never
your full transaction history, in either mode.

Where that data goes depends on `LLM_ALLOWED_HOSTS`. Keep it on localhost or
the bundled `ollama` container and it never leaves the machine. Point it at
a remote host and your aggregated finances travel to that server, which is
allowed but is a decision you're making deliberately. Remote hosts are
required to be `https://`, plain HTTP is refused.

## Setup with Docker

You need the `ollama` container plus the model. Nothing to change in `.env`:
adding the overlay is itself the opt-in, so it forces `LLM_ENABLED=true` for
the app container regardless of what your `.env` says. It used to leave you
with a running Ollama container, a downloaded model and no AI in the app if
`.env` still said `false`, with nothing explaining why.

`LLM_ENABLED` in `.env` still governs the setups that don't use this
overlay, such as a bare-metal run or `npm run dev`.

### 1. Start both services

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d --build
```

Published image instead:

```bash
docker compose -f docker-compose.prebuilt.yml -f docker-compose.ai.yml up -d
```

The two `-f` flags merge the base stack with the Ollama overlay. First run
downloads the `ollama/ollama` image, which is around 3 GB compressed and
several more once unpacked, so give it a few minutes and check you have the
disk for it.

### 2. Pull a model

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml exec ollama ollama pull qwen2.5:0.5b
```

If that errors with something about the container not running, wait ten
seconds and run it again, Ollama was still booting.

The model name must match `LLM_MODEL` in `.env`. They default to
`qwen2.5:0.5b`, which is tiny: it runs on anything, and the advice it
produces is correspondingly basic. If you have a real GPU, pull something
bigger and update both:

```dotenv
LLM_MODEL=qwen2.5:7b
```

Then `docker compose ... up -d` again to pick up the change.

### 3. Enable it for your account

The env flag is the global gate. Each user also flips their own switch in
**Settings**. Both have to be on before anything appears on the dashboard.

## GPU or not

The overlay above runs Ollama on the CPU. That works on any machine, and with
a small model on a modern one it is perfectly usable. Nothing to install and
nothing to configure.

Have an NVIDIA GPU? Install
[nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host, not in the container, then add one more overlay to every command:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
  -f docker-compose.ai.gpu.yml up -d --build
```

Published image instead:

```bash
docker compose -f docker-compose.prebuilt.yml -f docker-compose.ai.yml \
  -f docker-compose.ai.gpu.yml up -d
```

`docker-compose.ai.gpu.yml` goes on top of `docker-compose.ai.yml`, never
instead of it: it adds the GPU reservation and nothing else. Add it on a host
without the toolkit and `up` fails outright with "could not select device
driver", so add it only once the toolkit is in place.

## Without Docker

For the `npm run dev` setup, two scripts handle it:

```bash
npm run setup:llm    # installs Ollama if needed and pulls the model
npm run dev:ai       # dev server, making sure Ollama is running first
```

`LLM_BASE_URL` defaults to `http://127.0.0.1:11434`, which is where a local
Ollama listens.

## The first load is the slow one

The dashboard doesn't wait for the model. The page renders immediately and
the AI card shows a pending state until the advice arrives, so a slow
generation costs you a late card, never a late page.

Expect the first one after starting the stack to take a while: Ollama has to
load the model into memory before it can generate anything. Later loads are
much faster, seconds or less with a small model. On CPU, everything here is
slower but still works.

### Two budgets, not one

Reaching Ollama and waiting for it to generate are timed separately, because
they need very different amounts of patience.

| Variable                 | Default | Covers                                                                                 |
| ------------------------ | ------- | -------------------------------------------------------------------------------------- |
| `LLM_CONNECT_TIMEOUT_MS` | 2000    | Whether anything is listening at `LLM_BASE_URL`. Spent first.                          |
| `LLM_TIMEOUT_MS`         | 45000   | Loading the model and generating the advice. Spent only after the first one succeeded. |

The split is what lets the second number be generous. A stopped Ollama is
reported in about two seconds instead of costing the whole generation budget,
so raising `LLM_TIMEOUT_MS` slows down nothing except the case that genuinely
needs the time.

If the card consistently reports a cold start, raise `LLM_TIMEOUT_MS` and
restart. If it reports that nothing is reachable and you know the service is
slow to accept connections, for example because it runs on another machine,
raise `LLM_CONNECT_TIMEOUT_MS` instead.

Both defaults apply out of the box, including with the Docker overlay.

Earlier versions of the overlay set `LLM_TIMEOUT_MS` to 10000 regardless of
what this page said. On the first dashboard visit that aborted the model load
and reported the assistant as unavailable (#524). If you worked around it by
setting `LLM_TIMEOUT_MS` in your own `.env`, you can remove the line.

## Nothing shows up

If AI is disabled there's no card and no error, because a disabled optional
feature shouldn't nag you. That silence is deliberate and is not a fault.

When the card does appear and carries no advice, it names which of five things
happened. Read the card first: it tells you which of the steps below to skip.

| The card says                  | What happened                                                                           | What to do                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The assistant is starting      | Ollama accepted the connection and was still loading the model when the budget ran out. | Reload the page in a moment. If it repeats on every load, raise `LLM_TIMEOUT_MS`. |
| The assistant is not reachable | Nothing answered at `LLM_BASE_URL` inside the connect budget.                           | Check the service is up: `docker compose ... logs ollama`.                        |
| The address was refused        | `LLM_BASE_URL` is outside the host allowlist, so it was never contacted.                | Check `LLM_BASE_URL` against `LLM_ALLOWED_HOSTS` and `LLM_HTTP_PERMITTED_HOSTS`.  |
| The model is not installed     | Ollama is running and does not have the model it was asked for.                         | Pull it, and check `LLM_MODEL` matches the pulled tag exactly.                    |
| The answer was unreadable      | A generation finished and could not be parsed.                                          | Usually clears on the next analysis. A larger model makes it rarer.               |

Only the first of these clears on its own. The other four wait for you, which
is why the card no longer tells you to try again later for all five.

If the card never appears at all, work through these in order:

1. The AI overlay actually in your `docker compose` command
   (`-f docker-compose.ai.yml`), and the app restarted since. Outside
   Docker, `LLM_ENABLED=true` in `.env`.
2. The per-user switch on in Settings.
3. The model actually pulled:
   `docker compose ... exec ollama ollama list` should show it.
4. `LLM_MODEL` in `.env` spelled exactly like the pulled tag,
   `qwen2.5:0.5b` and `qwen2.5` are different names.
5. Enough data: an account with four transactions gives the model nothing
   to comment on.
6. Still on the first load? While the card shows its pending state it fills
   in on its own, without reloading the page. Once it has settled on one of
   the five outcomes above it will not change until you reload.
