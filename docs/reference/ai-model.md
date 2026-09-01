# What the AI advice requires of a model

The optional [local AI advice](../ai-insights.md) works against a model you
pull yourself, and not every model can do the job. This page states what the
app asks of one, so you can tell before pulling several gigabytes.

Setting it up is on the [AI advice page](../ai-insights.md); this one is only
about the model.

## The four requirements

The first three are pass or fail: a model that misses any of them produces a
card with no advice on it. The fourth is different in kind, and the difference
is worth stating rather than rounding into the list. A model with no reasoning
to suppress meets it for free, and a model that reasons meets it by honouring
`think: false`. What is left over is a model that reasons and ignores the
field, which is the one case nothing here has measured; see what this does not
promise, below.

| Requirement                              | What the app does about it                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Answers over `/api/chat` on Ollama       | `LLM_PROVIDER` accepts `ollama` and nothing else.                                                                                |
| Honours a JSON schema passed as `format` | The schema is sent on every request. A model that replies in prose fails validation and the card says the answer was unreadable. |
| Fits its answer in 1060 generated tokens | Sent as `num_predict`. Derived from the schema, not chosen.                                                                      |
| Suppresses reasoning when told to        | `think: false` is sent on every request, to every model.                                                                         |

The last one also asks something of the **server**, not only the model. An
Ollama old enough not to know the `think` field ignores it without an error, so
a reasoning model on such a server fails exactly as it would if the field were
never sent. The bundled overlay pins `ollama/ollama:0.32.5`, which is what
every measurement on this page was taken on; a hand-installed Ollama is not
covered by that pin.

### The token ceiling is derived, not configured

There is no setting for it, and adding one would not help.

The response schema bounds every field: `summary` is at most 160 characters,
each of at most 5 insights carries a title of 80, a message of 240, and two
values from closed lists. So the longest answer the schema permits is a
constant, computed at **2328 characters**, and the ceiling is that figure
converted at a pessimistic 2.5 characters per token plus 128 tokens of
structure, giving **1060**.

Raising the schema's limits moves the ceiling automatically. A model that
truncates at 1060 tokens is not short of room for the answer; it is spending
the room on something else.

### Reasoning is suppressed, and this is why it matters

A reasoning model writes its reasoning before it writes the answer, and those
tokens come out of the same budget. The ceiling can therefore be correctly
sized for the schema and the answer still arrive cut in half, or not at all.

Measured on `qwen3.5:4b-q8_0` under Ollama 0.32.5, on the same prompt:

|                        | Stopped because | Tokens generated | Answer         |
| ---------------------- | --------------- | ---------------- | -------------- |
| Without `think: false` | ran out of room | 1060             | nothing at all |
| With `think: false`    | finished        | 282              | complete       |

So the field is not a saving. On a model that reasons it is the difference
between advice and an error card. It is sent to every model, including ones
with no reasoning to suppress, because those accept it and generate normally.

## What this does not promise

- **Nothing is claimed about a model that ignores `think: false`.** Every
  model tested honours it. One that does not would reason anyway and could
  still overrun the ceiling, and there is no setting that would rescue it.
  Pick a different model.
- **No quality claim.** Meeting all four requirements means the advice
  arrives and is readable. Whether it is any good is a property of the model,
  and a small one gives correspondingly basic advice.
- **No per-model tuning.** Every model gets the same prompt, the same schema
  and the same ceiling. There is no setting to raise the ceiling for a
  particular model, on purpose: the schema is what the ceiling has to cover.
- **No list of blessed models.** Ollama's catalogue moves faster than this
  page can, and a list would go stale silently. The four requirements above
  are the test.

## Working out whether a model qualifies

Ollama reports what a model can do, which answers the reasoning question
before you pull anything:

```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml \
  exec ollama ollama show qwen2.5:0.5b
```

A `thinking` capability means the model reasons, and the app will send
`think: false` to switch it off. The absence of one means there was nothing
to switch off. Either is fine.

The honest test is the card itself. Pull the model, set `LLM_MODEL`, restart,
and load a dashboard on a month with real data in it. The
[table of card outcomes](../ai-insights.md#nothing-shows-up) names which of
the requirements above went wrong:

- **AI answer unreadable**: the model did not honour the schema.
- **AI answer was cut short**: the model overran the ceiling. On a reasoning
  model that means it kept reasoning; on any model it means it wrote past the
  schema's own maximum.
- **AI model not installed**: `LLM_MODEL` and the pulled tag differ.
