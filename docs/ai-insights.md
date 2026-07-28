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

There's one opt-in switch per user in Settings that adds the labels of your
largest expenses, the same ones already shown in the insights above the
card. Never your full transaction history, in either mode.

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
downloads the `ollama/ollama` image, which is over a gigabyte, so give it a
few minutes.

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

The overlay asks for an NVIDIA GPU through
[nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
which has to be installed on the host, not in the container.

No GPU, or not NVIDIA? Delete the `deploy.resources` block from
`docker-compose.ai.yml`. Ollama falls back to CPU: it works, it's slower,
and with a small model on a modern machine it's perfectly usable.

## Without Docker

For the `npm run dev` setup, two scripts handle it:

```bash
npm run setup:llm    # installs Ollama if needed and pulls the model
npm run dev:ai       # dev server, making sure Ollama is running first
```

`LLM_BASE_URL` defaults to `http://127.0.0.1:11434`, which is where a local
Ollama listens.

## Nothing shows up

The card has three states, and the quiet one is deliberate: if AI is
disabled, there's no card and no error, because a disabled optional feature
shouldn't nag you.

Work through these in order:

1. The AI overlay actually in your `docker compose` command
   (`-f docker-compose.ai.yml`), and the app restarted since. Outside
   Docker, `LLM_ENABLED=true` in `.env`.
2. The per-user switch on in Settings.
3. The model actually pulled:
   `docker compose ... exec ollama ollama list` should show it.
4. `LLM_MODEL` in `.env` spelled exactly like the pulled tag,
   `qwen2.5:0.5b` and `qwen2.5` are different names.
5. Enough data. There's nothing to comment on in an account with four
   transactions.

If the card says the service is unavailable, the app reached the point of
trying and failed. Check `docker compose ... logs ollama`.
