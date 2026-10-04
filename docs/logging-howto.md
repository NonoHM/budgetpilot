# Read, filter and check the log

**Audience:** whoever runs the instance. **Type:** how-to.

Recipes for the everyday log tasks. If you have never read the log, start with
[Your first look at the logs](./logging-tutorial.md). The fields and events are in
[Logs](./logging.md).

The commands assume Docker Compose and a folder that holds your Compose file. Tell Compose which
file to use once per terminal, so the commands stay short:

```bash
export COMPOSE_FILE=docker-compose.prebuilt.yml
```

The `jq` recipes need `jq`, a program that reads JSON. Install it with your system's package
manager. A line of the log is a JSON object, and `jq -R 'fromjson? | ...'` reads each line as text,
parses it, and skips the lines that are not JSON. Those lines are the database tool's output at
start. [Keep the lines that are not JSON](#keep-the-lines-that-are-not-json) says how to keep them.

## Read the log

- To print everything the container has kept:

  ```bash
  docker compose logs --no-log-prefix budgetpilot
  ```

- To follow the log as it is written, and stop with Ctrl+C:

  ```bash
  docker compose logs --no-log-prefix --follow budgetpilot
  ```

- To print only the lines from the last ten minutes:

  ```bash
  docker compose logs --no-log-prefix --since 10m budgetpilot
  ```

- To print only the last line:

  ```bash
  docker compose logs --no-log-prefix --tail 1 budgetpilot
  ```

  The output is one long line:

  ```text
  {"severity_text":"INFO","severity_number":9,"timestamp":"2026-10-03T16:32:28.591Z","event_name":"budgetpilot.request.not_found","trace_id":"203e35a691494747b3a8ade20c268b03","http.request.method":"GET","service.name":"budgetpilot","http.response.status_code":404,"budgetpilot.error.id":"203e35a6-9149-4747-b3a8-ade20c268b03","budgetpilot.log.schema":1,"budgetpilot.log.boot_id":"a5b43bf6-643a-4606-89bc-c88850c69ed3","budgetpilot.log.seq":9,"budgetpilot.log.prev":"66ed7a9a2126fd8f048e6e62178e5bbd241db91fe4bdadb1962c4c18a8f9cffe","body":"A request matched no page."}
  ```

`docker compose logs` shows only what Docker has kept for the current container. Recreating the
container, which `docker compose up -d` does after you change its configuration, discards the log of
the old one. Save a copy first when you want to keep it:

```bash
docker compose logs --no-log-prefix budgetpilot > budgetpilot-before-change.log
```

## Filter the log with jq

Each recipe below was run against a real instance. The output is what that run printed.

### Show errors only

To print every line at `ERROR` (17) or above:

```bash
docker compose logs --no-log-prefix budgetpilot | jq -cR 'fromjson? | select(.severity_number >= 17)'
```

```text
{"severity_text":"ERROR","severity_number":17,"timestamp":"2026-10-03T16:32:00.674Z","event_name":"budgetpilot.request.failed","trace_id":"15461b1bba154959b83acbb5dfcd8da5","http.request.method":"GET","http.route":"/net-worth","service.name":"budgetpilot","error.type":"PrismaClientKnownRequestError","budgetpilot.error.code":"P2021","http.response.status_code":500,"budgetpilot.error.id":"15461b1b-ba15-4959-b83a-cbb5dfcd8da5","budgetpilot.log.schema":1,"budgetpilot.log.boot_id":"a5b43bf6-643a-4606-89bc-c88850c69ed3","budgetpilot.log.seq":6,"budgetpilot.log.prev":"ebe4955d6b96b69a9d4611b5390bd038b66e384e8baa3670a82060222439a069","body":"A request failed on an unexpected error. The error id is the reference the visitor was shown."}
```

Use `>= 13` for warnings and above. The scale is `DEBUG` 5, `INFO` 9, `WARN` 13, `ERROR` 17 and
`FATAL` 21.

### Show one kind of event

To print the time and the request id of every "page not found":

```bash
docker compose logs --no-log-prefix budgetpilot | jq -cR 'fromjson? | select(.event_name == "budgetpilot.request.not_found") | [.timestamp, .trace_id]'
```

```text
["2026-10-03T16:31:32.689Z","b226d318b614407397c844c6ca99f14b"]
["2026-10-03T16:32:28.578Z","1dfc16dbea6049f5842e151b8b7a3070"]
["2026-10-03T16:32:28.585Z","56340424f98749d68d249bfcc5543d37"]
["2026-10-03T16:32:28.591Z","203e35a691494747b3a8ade20c268b03"]
```

Replace the event name with any name in [the event list](./logging.md#every-event).

### Show one error by its reference

An error page shows the visitor a reference. To print the line behind it, keep the reference in a
variable and search for it. Replace the value with the reference you were given.

```bash
REF=15461b1b-ba15-4959-b83a-cbb5dfcd8da5
```

```bash
docker compose logs --no-log-prefix budgetpilot | jq -cR --arg ref "$REF" 'fromjson? | select(.["budgetpilot.error.id"] == $ref) | [.event_name, .["http.route"], .["error.type"], .["budgetpilot.error.code"]]'
```

```text
["budgetpilot.request.failed","/net-worth","PrismaClientKnownRequestError","P2021"]
```

To print the whole line, end the filter after `select(.["budgetpilot.error.id"] == $ref)` and drop
the `-c` option, as the tutorial does.

### Show one request by its trace id

The `trace_id` is the reference without its dashes. To print the lines of one request from a
reference, convert it:

```bash
docker compose logs --no-log-prefix budgetpilot | jq -R --arg ref "$REF" 'fromjson? | select(.trace_id == ($ref | gsub("-"; "")))'
```

```text
{
  "severity_text": "ERROR",
  "severity_number": 17,
  "timestamp": "2026-10-03T16:32:00.674Z",
  "event_name": "budgetpilot.request.failed",
  "trace_id": "15461b1bba154959b83acbb5dfcd8da5",
  "http.request.method": "GET",
  "http.route": "/net-worth",
  "service.name": "budgetpilot",
  "error.type": "PrismaClientKnownRequestError",
  "budgetpilot.error.code": "P2021",
  "http.response.status_code": 500,
  "budgetpilot.error.id": "15461b1b-ba15-4959-b83a-cbb5dfcd8da5",
  "budgetpilot.log.schema": 1,
  "budgetpilot.log.boot_id": "a5b43bf6-643a-4606-89bc-c88850c69ed3",
  "budgetpilot.log.seq": 6,
  "budgetpilot.log.prev": "ebe4955d6b96b69a9d4611b5390bd038b66e384e8baa3670a82060222439a069",
  "body": "A request failed on an unexpected error. The error id is the reference the visitor was shown."
}
```

If you already have a `trace_id`, compare `.trace_id == "<value>"` directly.

### Count events by name

To count the lines of each event, most frequent first:

```bash
docker compose logs --no-log-prefix --since 10m budgetpilot | jq -r -R 'fromjson? | .event_name' | sort | uniq -c | sort -rn
```

```text
      4 budgetpilot.request.not_found
      1 sys_startup
      1 budgetpilot.request.failed
      1 budgetpilot.console.output
      1 budgetpilot.config.trusted_proxies_unset
      1 budgetpilot.config.origin_set
```

Change `--since 10m` to the window you want, or remove it to count everything the container kept.

A visitor can cause some events without signing in, so the server writes the first 20 of one event
per minute and then one `budgetpilot.log.suppressed` line with the count of the rest. When the
count above looks low, look for that line:
[Why repeats are summarised](./explanation/logging-design.md#why-repeats-are-summarised).

## Keep the lines that are not JSON

Dropping the lines that `jq` cannot parse hides the database tool's output. That output is where a
failed migration explains itself. To keep every line, print the unparsable ones as a `plain` value:

```bash
docker compose logs --no-log-prefix budgetpilot | jq -cR 'fromjson? // {plain: .}' | head -n 3
```

```text
{"plain":"Loaded Prisma config from prisma.config.ts."}
{"plain":""}
{"plain":"Prisma schema loaded from prisma/schema.prisma."}
```

On an instance whose log held 186 lines, `docker compose logs --no-log-prefix budgetpilot | wc -l`
printed 186. The command that skips the plain lines (`jq -cR 'fromjson?'`) printed 9 lines, and the
one above (`jq -cR 'fromjson? // {plain: .}'`) printed all 186. Put `wc -l` at the end of each
command to get your own three figures.

To print only the lines that are not BudgetPilot's:

```bash
docker compose logs --no-log-prefix budgetpilot | grep -v '^{'
```

## Check that the log rotates

The shipped Compose files tell Docker to keep at most five files of 10 MB for BudgetPilot. To see
what Docker applies to the running container:

```bash
docker inspect --format '{{json .HostConfig.LogConfig}}' budgetpilot
```

```text
{"Type":"json-file","Config":{"max-file":"5","max-size":"10m"}}
```

`json-file` is Docker's default log driver. `max-size` is the size of one file and `max-file` is how
many Docker keeps, so this instance keeps at most 50 MB and deletes the oldest data first. This is a
bound on size, not on age. If `Type` is something else, or `Config` is empty, the container was not
started from a shipped Compose file, and the log grows without a bound.

## Change the size bound

1. Create a file named `docker-compose.logging.yml` next to your Compose file, with the new bound.
   This one keeps three files of 20 MB.

   ```yaml
   services:
     budgetpilot:
       logging:
         options:
           max-size: '20m'
           max-file: '3'
   ```

1. Save a copy of the current log, because the next step recreates the container.

   ```bash
   docker compose logs --no-log-prefix budgetpilot > budgetpilot-before-change.log
   ```

1. Start the container with both files.

   ```bash
   docker compose -f docker-compose.prebuilt.yml -f docker-compose.logging.yml up -d
   ```

1. Check what Docker now applies.

   ```bash
   docker inspect --format '{{json .HostConfig.LogConfig}}' budgetpilot
   ```

   ```text
   {"Type":"json-file","Config":{"max-file":"3","max-size":"20m"}}
   ```

Pass both `-f` options each time you run `docker compose` for this instance, or set
`COMPOSE_FILE=docker-compose.prebuilt.yml:docker-compose.logging.yml`. With only the first file,
Compose goes back to the shipped bound and recreates the container again.

## Change the log level

`BP_LOG_LEVEL` sets the lowest severity written: `debug`, `info` (the default) or `warn`. There is no
`error` value, so the startup and crash lines can never be hidden.

1. Add the setting to the `.env` file next to your Compose file.

   ```text
   BP_LOG_LEVEL=warn
   ```

1. Save a copy of the log, then recreate the container.

   ```bash
   docker compose logs --no-log-prefix budgetpilot > budgetpilot-before-change.log
   docker compose up -d
   ```

1. Check the result. Ask for a page that does not exist, then list the severity and event name of
   the lines from the last 30 seconds:

   ```bash
   curl -s -o /dev/null http://localhost:3000/missing
   docker compose logs --no-log-prefix --since 30s budgetpilot | jq -cR 'fromjson? | [.severity_text, .event_name, .["budgetpilot.config.log_level"]]'
   ```

   ```text
   ["WARN","sys_startup","warn"]
   ["WARN","budgetpilot.config.origin_set",null]
   ["WARN","budgetpilot.config.trusted_proxies_unset",null]
   ["WARN","budgetpilot.config.log_level_changed","warn"]
   ["WARN","budgetpilot.console.output",null]
   ```

   The "page not found" is `INFO`, so it is not written. The startup lines are all `WARN`, so they
   are. Among them, the server states at each start that the level differs from its default
   (`budgetpilot.config.log_level_changed`).

To go back, delete the line from `.env`, save a copy of the log and run `docker compose up -d` again.

## Check that no line was removed or edited

Each line carries its number (`budgetpilot.log.seq`) and the SHA-256 hash of the line before it
(`budgetpilot.log.prev`). A script can check both on a copy of the log. The numbering restarts at 1,
under a new `budgetpilot.log.boot_id`, at every start of the server, so the script checks each start
on its own.

1. Save the log to a file.

   ```bash
   docker compose logs --no-log-prefix budgetpilot > capture.log
   ```

1. Save this script as `verify_chain.py`. It needs Python 3 and nothing else.

   ```python
   #!/usr/bin/env python3
   """Check the BudgetPilot log chain in a captured log. Usage: verify_chain.py FILE"""
   import hashlib
   import json
   import sys

   ZERO = "0" * 64
   SEQ, PREV, BOOT = "budgetpilot.log.seq", "budgetpilot.log.prev", "budgetpilot.log.boot_id"

   problems = []
   skipped = 0
   boots = {}  # boot_id -> what has been seen of that start of the server
   order = []

   with open(sys.argv[1], "rb") as handle:
       lines = handle.read().split(b"\n")
   if lines and lines[-1] == b"":
       lines.pop()  # the newline that ends the file is not a line

   for number, raw in enumerate(lines, start=1):
       try:
           record = json.loads(raw)
           boot, seq, prev = record[BOOT], record[SEQ], record[PREV]
       except (ValueError, KeyError, TypeError):
           skipped += 1  # not one of ours, such as prisma migrate deploy's text
           continue
       state = boots.get(boot)
       if state is None:
           order.append(boot)
           if seq != 1:
               print(f"note: boot {boot} starts at seq {seq}, so earlier lines are not in this file")
           elif prev != ZERO:
               problems.append(f"line {number}: first line of boot {boot} should carry 64 zeros in prev")
           state = boots[boot] = {"first": seq, "last": seq, "lines": 0, "hash": None}
       else:
           if seq != state["last"] + 1:
               problems.append(
                   f"line {number}: seq jumps from {state['last']} to {seq}, "
                   f"so {seq - state['last'] - 1} line(s) are missing before it"
               )
           if prev != state["hash"]:
               if seq == state["last"] + 1:
                   problems.append(
                       f"line {number}: prev does not match line {state['number']} (seq {state['last']}), "
                       "so that line was changed after it was written"
                   )
               else:
                   problems.append(f"line {number}: prev does not match the line before it")
       state["last"], state["number"] = seq, number
       state["lines"] += 1
       state["hash"] = hashlib.sha256(raw).hexdigest()

   for boot in order:
       s = boots[boot]
       print(f"boot {boot}: {s['lines']} lines, seq {s['first']} to {s['last']}")
   print(f"{skipped} line(s) skipped because they are not BudgetPilot log lines")
   for problem in problems:
       print("PROBLEM", problem)
   print("chain intact" if not problems else f"{len(problems)} problem(s) found")
   sys.exit(1 if problems else 0)
   ```

   The hash is taken over each line as written, without its closing newline, which is what the
   server hashes.

1. Run it.

   ```bash
   python3 verify_chain.py capture.log
   ```

   For a log that has not been touched, it prints:

   ```text
   boot 917d7fb1-0a3d-47be-83ca-d758710274f4: 26 lines, seq 1 to 26
   177 line(s) skipped because they are not BudgetPilot log lines
   chain intact
   ```

   The exit status is 0. A log with several starts in it lists each one:

   ```text
   boot 917d7fb1-0a3d-47be-83ca-d758710274f4: 26 lines, seq 1 to 26
   boot 69b74857-f687-4cf6-952a-ffd103b3ba5d: 5 lines, seq 1 to 5
   186 line(s) skipped because they are not BudgetPilot log lines
   chain intact
   ```

   A file that starts in the middle of a start, such as the output of `--tail 4`, is checked from its
   first line on, and the script says so:

   ```text
   note: boot 69b74857-f687-4cf6-952a-ffd103b3ba5d starts at seq 2, so earlier lines are not in this file
   boot 69b74857-f687-4cf6-952a-ffd103b3ba5d: 4 lines, seq 2 to 5
   0 line(s) skipped because they are not BudgetPilot log lines
   chain intact
   ```

### Check that the script finds a removed or edited line

A check that has never reported a problem has not been shown to work. Make damaged copies of your
capture and run the script on each. The commands below remove the line numbered 10 and, in another
copy, change a status code in the line numbered 15. They apply to a capture that has at least 16
numbered lines whose 15th is a "page not found".

```bash
sed '/"budgetpilot.log.seq":10,/d' capture.log > deleted.log
sed '/"budgetpilot.log.seq":15,/s/"http.response.status_code":404/"http.response.status_code":200/' capture.log > edited.log
python3 verify_chain.py deleted.log
python3 verify_chain.py edited.log
```

On the capture above, the script printed this for the copy with a line removed, and exited with
status 1:

```text
boot 917d7fb1-0a3d-47be-83ca-d758710274f4: 25 lines, seq 1 to 26
177 line(s) skipped because they are not BudgetPilot log lines
PROBLEM line 187: seq jumps from 9 to 11, so 1 line(s) are missing before it
PROBLEM line 187: prev does not match the line before it
2 problem(s) found
```

For the copy with a line edited:

```text
boot 917d7fb1-0a3d-47be-83ca-d758710274f4: 26 lines, seq 1 to 26
177 line(s) skipped because they are not BudgetPilot log lines
PROBLEM line 193: prev does not match line 192 (seq 15), so that line was changed after it was written
1 problem(s) found
```

The line numbers are positions in the file, counting the lines that are not JSON. The script does not
point at the damaged line itself: it points at the line after it, which is the one whose `prev` no
longer matches.

### What a problem means, and what the check cannot see

- **A gap in `seq`** means one or more lines are missing between two that are there.
- **A `prev` that does not match** means the line before it was changed after it was written, or a
  line was removed or inserted before this one.
- **Both on the same line** is what a removal looks like, as in the first example above.

The chain has no secret key, so it protects against someone changing a copy of the log, not against
someone who controls the machine. It cannot detect:

- **A change to the last line of a capture.** Nothing follows it to disagree. In the capture above,
  the last numbered line is 26. Changing a value in that line only
  (`sed '/"budgetpilot.log.seq":26,/s/"budgetpilot.log.suppressed_count":9/"budgetpilot.log.suppressed_count":1/' capture.log > edited-last.log`)
  made the script print `chain intact` and exit with status 0. Keep a later capture to confirm the
  end of an earlier one.
- **Lines cut off the end.** A capture that stops early is still a valid chain.
- **Lines before the start of a capture.** The script only says that the capture starts at a line
  other than 1.
- **A rewrite of the whole file.** Whoever can write the file can recompute every hash.

For the last case, the copy that matters is the one held somewhere the host cannot change. See
[Send the log to a collector](./logging-collectors.md).

---

If you use an instance someone else runs, [what the security log records about you](./using/security-logging.md)
is the page written for you.
