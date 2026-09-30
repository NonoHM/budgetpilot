# The blind user test: end of a chantier, before its release PR

It answers two questions. Does a user who knows nothing about the code complete the journeys on the
image that ships? Does anything that worked on the previous release now fail? It also runs a leak
check. It cannot answer anything about a real bank (synthetic shapes only), anything no tester tried,
or anything a tester claims that the database does not confirm.

## Before anything: is there something to test?

The test runs once, after every PR of the chantier has merged and before its release PR. It needs a
candidate (the merge commit that will be released), a baseline (the previous release's image) and
this chantier's journeys, written from its plan. If any of the three is missing, stop and say which:
running it on the wrong candidate, or with the last release's tasks, measures something else.

## The ten rules, versioned as one protocol

Changing any of the tasks, personas, models or number of runs starts a new series of comparisons.
Write the protocol version in the report.

1. **An agent succeeding proves little; an agent failing is strong evidence.** Agents finish more
   tasks than humans and find few of the blocking points humans hit, so « Y fails where X passes » is
   the regression signal and a pass is weak evidence.
2. **Ask for a replay after each task**: the tester re-reads its own steps and names each point that
   blocked it.
3. **No SUS, SEQ or UMUX-Lite with agents**: they answer questionnaires too positively. Measure
   behaviour: success from the database oracle, number of actions, errors, and lostness (above 0.5 is
   lost). SUS stays for a human round.
4. **The 30-second rule is a comprehension question plus the first action**, not a stopwatch, because
   an agent's time is mostly the model's own latency. On arrival at a screen, before any action: what
   is it for, what do you do first? Then: was the first action right? The first click predicts
   success.
5. **Repeat each task k times** and report « x of k » with a 95 % interval (adjusted Wald): one run
   hides variation.
6. **A fresh tester session per image and width** (X390, Y390, X1280, Y1280), with a fresh volume per
   tester, instead of alternating the order: an agent only remembers through its context.
7. **Raters do not come from the builder's model family** where that is possible; say so where it is
   not. Each finding is rated alone, in shuffled order, by three raters, and the median is the
   severity. Planted findings of known severity calibrate the raters.
8. **Keep the interface's words out of the tasks**, checked mechanically against the catalogue of the
   locale the tester sees (calibrated on a planted known string). The tester types no URL beyond the
   start page and runs no code in the page.
9. **The accessibility tree is not a screen reader.** Run axe-core (WCAG A and AA) at both widths; a
   daily screen-reader user is still needed, and the report says that round has not happened.
10. **This list is the protocol.** Version it as a whole.

## Setup

- **Both sides are images**, never a dev server: the previous release's published image as baseline,
  the candidate built from the merge commit with the repository's Dockerfile.
- **Names that cannot reach the owner's instance.** `budgetpilot-test` holds real data, and a prefix
  sweep over that name destroys it. Give every container and volume a prefix of your own, and remove
  only what you created, by exact name.
- **Secrets generated fresh** for the run; assert each one's LENGTH and never print a value
  (`cut -d= -f2` truncates a base64 secret at its padding; use `sed -n 's/^KEY=//p'`).
- **Blinding**: a coin flip assigns baseline and candidate to X and Y. The key sits in the
  scratchpad, is never named to a tester or a rater, and is read only after every finding is rated.
- **The browser**: the Playwright MCP. Adding a dedicated, isolated server changes the owner's MCP
  configuration, so it needs the owner's approval at run time. If the browser hangs at startup, drive
  scripted headless Playwright instead and say so in the report.
- **Tasks** are goals, never paths: no interface vocabulary, an explicit end, a database oracle per
  task. Testers receive file paths, never contents to retype. Pilot one task on one side first.

## Checkmarks, per screen met for the first time

Screen, width, understood (yes or no), first action right (yes or no), the tester's own words. A
screen misread, or not understood on arrival, is a finding at severity 2 or more whatever the oracle
says, and a screen slower to understand than its baseline counterpart is a regression even when both
pass.

## The mini pentest

A separate agent, after the testers, on the candidate only, with the same browser rules and data:
the cases in [clumsy-user.md](clumsy-user.md).

## Oracles and the leak check

- Copy the SQLite file out of each volume, query the copy, delete it. Print the copy's byte size
  beside every count, so an empty read cannot pass as a clean one.
- **Log leak check**: grep each side's logs for planted synthetic identifiers (the holder's name, two
  labels, two amounts, spelled as the files spell them). Calibrate in the same pass: append one
  planted line to a COPY of the log and assert the grep finds exactly that one. Print the log's size.
- **Origin audit**: every origin a tester's browser requested must be the side's own. Any other is
  severity 4.

## Scoring, unblinding, filing

- Each finding: task, side, what the tester expected, what happened, the oracle's answer, a
  reproduction in steps. Severity 0 to 4 (4: imperative to fix before release).
- After rating, read the key and classify each finding: REGRESSION (baseline passed its oracle, the
  candidate did not), INTENDED CHANGE (still a finding if it confused), PRE-EXISTING (both sides),
  AGENT ARTEFACT (the oracle contradicts the tester).
- Reproduce every regression with a scripted Playwright run before filing it. A regression rated 3
  or 4 blocks the release PR. File the rest as issues in structure only: synthetic data, no figure
  from anything real.
- Clean up by exact name; `git status --porcelain` is empty at the end.

The last run's full protocol, with its stack commands and task table, is in the gitignored plan notes
under `docs/superpowers/` when present. Its tasks belong to that release: write this chantier's own.
