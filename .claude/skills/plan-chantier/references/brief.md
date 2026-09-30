# A brief for an implementation session

A brief carries what is specific to one PR. Everything every session does is in the `ship` skill, so
it is invoked, not pasted. Fill every line; a line you cannot fill is a question for the plan, not
for the session.

```
PR <id>: <one-line title>. Tier <n>, because <the clause of AGENTS.md that decides it>.
Base: origin/main (or: stacked on <branch> at <sha>).
Closes: #A, #B. Leaves open: #C (<why>).
Does not: <what this PR deliberately leaves out>.
First step: <the measurement, how it is calibrated, what figure it must print>.
Standards: <ASVS v5.0.0-X.Y.Z lines, resolved with the cite skill>.
Screen: <the plate section that rules it> | <none: stop and report what the screen must show;
        the controller draws the canvas>.
Machine: port <p>, containers <prefix>-pg and <prefix>-maria, screenshots under scr/<chantier>/<id>/.
Model: sonnet (tier 1-2) | opus (tier 3).

Invoke the `ship` skill and follow it. You are an implementation session under a controller: do not
merge; on tier 3, push the branch and do not open the PR. Report on one screen, in the shape `ship`
gives.
```
