# Qualify, change or roll back the AI model

**Audience:** whoever runs the instance. **Type:** how-to.

Before the [local AI advice](./ai-insights.md) runs on a different model, check
that the model does the job on this app's own prompt, then switch to it in a way
you can undo. What a model has to do, and the default model with its measured
figures, are in [What the AI advice requires of a model](./reference/ai-model.md).

The commands assume the Docker setup from the AI advice page. Set the Compose
files once per terminal:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.ai.yml
```

With the published image, use `docker-compose.prebuilt.yml` instead of
`docker-compose.yml`.

## Qualify a model before you use it

`npm run ai:check` starts the app from a clone, signs in test members it
creates, writes synthetic months through the app's own forms, and asks the model
for advice through the dashboard in a real browser. It reads each answer twice:
as the app judged it, and as the model wrote it.

Run it against an Ollama of its own. Pointed at the Ollama your instance uses,
it would load models and queue requests beside your members.

1. In a clone of the repository at the version you run, install and build once:

   ```bash
   npm ci
   npm run db:generate
   DATABASE_URL=file:./dev.db npm run build
   npx playwright install chromium
   ```

2. Start a separate Ollama with its own volume and pull the model:

   ```bash
   docker run -d --name ollama-qualify --runtime runc -p 127.0.0.1:11435:11434 \
     -v ollama-qualify:/root/.ollama ollama/ollama:0.32.5
   docker exec ollama-qualify ollama pull <model:tag>
   ```

   `--runtime runc` keeps it on the CPU even on a host whose Docker defaults
   to the NVIDIA runtime, so the latency you read is the one a CPU install
   gets. Drop it, and add `--gpus all`, to measure on a GPU.

3. Run the check:

   ```bash
   BP_AI_CHECK_OLLAMA_URL=http://127.0.0.1:11435 BP_AI_CHECK_MODEL=<model:tag> \
     npm run ai:check
   ```

   `BP_AI_CHECK_RUNS` sets the runs per synthetic month (3 by default).

4. Read the last line. **Qualified** means every check passed. **Refused**
   lists each reason. The full report, with every raw answer, is in
   `test-results/ai-check/report.json`.

The check refuses a model when:

- any run ends without advice, for example an answer the app could not read;
- any answer was cut short by the token ceiling;
- the model obeyed an instruction planted in a category name;
- the model is the default and its weights are not the ones it was qualified
  with.

Two figures are counted and not refused, because a small model produces some of
both and the app's own rules decide what reaches the screen: figures in the
answer that the month does not hold, and category names read as something else
(« Courses », French for groceries, read as education). Compare them between
models rather than reading either as a pass.

## Change the model your instance uses

1. Keep the model you use now under a second name. The copy holds the same
   weights and costs no disk:

   ```bash
   docker compose exec ollama ollama cp <current:tag> budgetpilot-known-good:latest
   ```

2. Pull the new model:

   ```bash
   docker compose exec ollama ollama pull <model:tag>
   ```

3. Set `LLM_MODEL=<model:tag>` in `.env` and restart the app:

   ```bash
   docker compose up -d
   ```

4. Check that the weights are the ones you qualified. The `ID` column of
   `ollama list` is the first 12 characters of the digest the check reported:

   ```bash
   docker compose exec ollama ollama list
   ```

## Roll back to the previous model

Ollama cannot pull a model by digest, and a tag can move upstream, so pulling the
old tag again may bring back different weights. Restore the copy instead:

```bash
docker compose exec ollama ollama cp budgetpilot-known-good:latest <current:tag>
```

Set `LLM_MODEL` back to `<current:tag>` and restart the app, which also empties
the advice it keeps for an hour under the model's name:

```bash
docker compose up -d
docker compose restart budgetpilot
```

Check `ollama list` again. The restart matters when the tag itself was
overwritten: `LLM_MODEL` does not change, so `up -d` alone leaves the app
running with advice written by the weights you rolled away from. Measured on
Ollama 0.32.5: after the tag was overwritten with other weights, its `ID`
changed; copying the kept name back restored the original `ID` and the model
answered.

## Keep test and production models apart

Give each environment its own Ollama and its own volume: the qualification run
above, a development instance, and the one your members use. A model pulled to
try it, or a check that loads one, then never runs on the instance that serves
your members. The Compose overlay's Ollama publishes no port on the host, so a
check run from the host cannot reach it by mistake.

---

For what the advice looks like to a member and how they turn it on, see
[Account settings](./using/account.md).
