# Ban an address after failed sign-ins

**Audience:** whoever runs the instance behind the Caddy proxy that BudgetPilot ships
([Reverse proxy and HTTPS](./reverse-proxy.md)). **Type:** how-to.

BudgetPilot slows down someone guessing passwords on its own: after 5 failed sign-ins from one
address in 15 minutes, it refuses that address at the sign-in page for the rest of the window. This
page makes your proxy go further and ban the address from the whole site, with fail2ban or
CrowdSec. Pick one of the two.

## How the proxy knows a sign-in was refused

The application log names a client only by a pseudonym ([Logs](./logging.md)), so it cannot tell a
firewall which address to block. Caddy's access log keeps the real address. BudgetPilot therefore
marks each refused sign-in with a response header, and Caddy writes it on the same line as the
address:

```http
BudgetPilot-Sign-In: refused
```

In the access log it reads `"Budgetpilot-Sign-In": ["refused"]`, because Caddy writes header names
with only the first letter of each word capitalised. The status code cannot carry this signal: a
script can make every sign-in answer `200`.

| Answer                                                                                 | Marked | Why                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unknown email, or wrong password                                                       | Yes    | A guess was refused. Both get the same answer and the same mark, so the mark does not say whether an account exists.                             |
| Wrong second-factor code, a code already used, a wrong recovery code, or neither shape | Yes    | A guess was refused.                                                                                                                             |
| « Too many attempts »                                                                  | No     | The limit counts a group of addresses (an IPv6 /56 by default). A mark here would make the proxy ban everyone else in that group.                |
| A code checked against a second-factor secret the server cannot decrypt                | No     | The server's key is wrong, not the code ([Logs](./logging.md), `crypt_decrypt_fail`). A ban would also block the recovery code that still works. |
| A successful sign-in, or the request for the second factor                             | No     |                                                                                                                                                  |

A correct password or code is marked in a few cases: a code already used on another device or by a
double click within the same 30 seconds, a recovery code typed without its hyphen (#954), or a
sign-in at the moment the password or two-factor setting changes. This is why the recipes ban
after 5 marks and never after 1.

## Before you begin

- The stack runs with `docker-compose.proxy.yml`, so Caddy is the first server a visitor reaches. If
  another proxy sits in front of Caddy, read [Behind another proxy](#behind-another-proxy) first.
- fail2ban 1.1 or CrowdSec 1.8 is installed on the host, and you have root access to it.
- The commands run from the folder that holds your Compose files.

## Write Caddy's access log to a file

Caddy writes its access log to the container's output. The ban tools read a file on the host, so
move the log there.

1. In your `Caddyfile`, add an `output` line as the first line inside the `log` block:

   ```caddyfile
   log {
   	output file /var/log/caddy/access.log {
   		roll_keep_for 168h
   	}
   	format filter {
   ```

   The ban needs only the last 15 minutes. Caddy keeps rolled files for 90 days unless told
   otherwise, and each line holds a visitor's address, so keep them for the period your privacy
   notice states. `168h` is 7 days. The file is created readable by root only.

2. Create `docker-compose.caddy-log.yml` beside your other Compose files, to put that folder on the
   host:

   ```yaml
   services:
     caddy:
       volumes:
         - ./caddy-logs:/var/log/caddy
   ```

3. Restart the stack with the extra file:

   ```bash
   docker compose -f docker-compose.prebuilt.yml -f docker-compose.proxy.yml -f docker-compose.caddy-log.yml up -d
   ```

   If you build the image yourself, replace `docker-compose.prebuilt.yml` with `docker-compose.yml`
   and add `--build`.

4. Sign in once with a wrong password, then count the marked lines:

   ```bash
   sudo grep -c 'Budgetpilot-Sign-In' caddy-logs/access.log
   ```

   The count is `1`. The access log no longer appears in `docker compose logs caddy`.

## Ban with fail2ban

The filter reads the format the shipped `Caddyfile.example` writes. It takes the address only from
Caddy's `client_ip` field and the mark only from the response headers, so text a visitor sends, such
as a crafted user agent, cannot name another address.

1. Save the filter as `/etc/fail2ban/filter.d/budgetpilot.conf`:

   ```ini
   [Definition]

   datepattern = ^%%Y/%%m/%%d %%H:%%M:%%S(?:\.%%f)?

   failregex = ^\s*\S+\s+http\.log\.access\.\S+\s+handled request\s+\{"request": \{"remote_ip": "[^"]*", "remote_port": "[^"]*", "client_ip": "<ADDR>", .*, "resp_headers": \{.*"Budgetpilot-Sign-In": \["refused"\]

   ignoreregex =
   ```

2. Save the jail as `/etc/fail2ban/jail.d/budgetpilot.local`:

   ```ini
   [budgetpilot]
   enabled     = true
   filter      = budgetpilot
   logpath     = PATH/caddy-logs/access.log
   backend     = polling
   logtimezone = UTC
   maxretry    = 5
   findtime    = 15m
   bantime     = 1h
   banaction   = iptables-allports
   chain       = DOCKER-USER
   ```

   Replace `PATH` with the absolute path of the folder that holds your Compose files.

   - `logtimezone = UTC` is required. Caddy writes the time in UTC, and without this line fail2ban
     reads it as local time: on a host east of UTC every line looks too old and nobody is ever
     banned.
   - `maxretry = 5` and `findtime = 15m` match BudgetPilot's own limit. Its « too many attempts »
     answers are not marked, so one address cannot collect more than 5 marked password refusals in
     15 minutes, and a higher `maxretry` never bans a password guesser.
   - `chain = DOCKER-USER` is where the ban has to go. Caddy runs in a container with published
     ports, and Docker's forwarding rules take that traffic before the host's `INPUT` chain sees it.
     Docker documents `DOCKER-USER` as « A placeholder for user-defined rules that will be
     processed before rules in the `DOCKER-FORWARD` and `DOCKER` chains »
     ([Docker with iptables](https://docs.docker.com/engine/network/firewall-iptables/)). Packets
     there have already had their destination rewritten to the container's, so the jail bans the
     address on every port (`iptables-allports`).

3. Test the filter against your log:

   ```bash
   sudo fail2ban-regex PATH/caddy-logs/access.log /etc/fail2ban/filter.d/budgetpilot.conf
   ```

   The `Lines:` row reports as many `matched` lines as the marked-line count from the previous
   section.

4. Load the jail:

   ```bash
   sudo fail2ban-client reload
   ```

5. Check that the jail is running:

   ```bash
   sudo fail2ban-client status budgetpilot
   ```

   The output lists the jail with its `File list` pointing at the access log.

The filter, the jail's counting and its timing were tested. The firewall action itself was not run
in the tests behind this page: check with `sudo iptables -L DOCKER-USER -n` that a ban adds a rule
there. A host that uses nftables without the `iptables` commands needs another `banaction`.

## Ban with CrowdSec

CrowdSec's own Caddy parser reads the JSON format, so switch the access log to it. It then also
feeds CrowdSec's general web scenarios.

1. In your `Caddyfile`, in the `format filter` block of the access log, replace `wrap console` with
   `wrap json`. Keep the three `fields` lines.

2. Restart Caddy:

   ```bash
   docker compose -f docker-compose.prebuilt.yml -f docker-compose.proxy.yml -f docker-compose.caddy-log.yml restart caddy
   ```

3. Install the Caddy collection:

   ```bash
   sudo cscli collections install crowdsecurity/caddy
   ```

4. Tell CrowdSec to read the file, in `/etc/crowdsec/acquis.d/caddy.yaml`:

   ```yaml
   filenames:
     - PATH/caddy-logs/access.log
   labels:
     type: caddy
   ```

   Replace `PATH` with the absolute path of the folder that holds your Compose files.

5. Save the scenario as `/etc/crowdsec/scenarios/budgetpilot-sign-in-refused.yaml`:

   ```yaml
   type: leaky
   name: budgetpilot/sign-in-refused
   description: 'Repeated refused sign-ins at BudgetPilot'
   filter: |
     evt.Meta.log_type == 'http_access-log' && evt.Unmarshaled.caddy != nil && 'refused' in (evt.Unmarshaled.caddy.resp_headers['Budgetpilot-Sign-In'] ?? [])
   groupby: evt.Meta.source_ip
   capacity: 4
   leakspeed: 3m
   blackhole: 15m
   labels:
     service: http
     confidence: 3
     spoofable: 0
     classification:
       - attack.T1110
     label: 'BudgetPilot sign-in brute force'
     behavior: 'http:bruteforce'
     remediation: true
   ```

   The bucket holds 4 and empties by one every 3 minutes, so the fifth mark within 15 minutes
   raises an alert: the same threshold as BudgetPilot's own limit.

6. Check that a marked line reaches the scenario:

   ```bash
   sudo cscli explain --file PATH/caddy-logs/access.log --type caddy
   ```

   A line with the mark shows `budgetpilot/sign-in-refused` under its scenarios.

7. Reload CrowdSec:

   ```bash
   sudo systemctl reload crowdsec
   ```

CrowdSec decides who to ban; a bouncer applies the decision. Install one that acts on Docker's
forwarded traffic, for the same reason as the fail2ban jail above. The parser, the scenario and
the decision were tested; no bouncer was run in the tests behind this page.

## Behind another proxy

If a load balancer or another proxy sits in front of Caddy, Caddy only sees that proxy's address
until you tell it to trust the forwarded one. Set both options in the global block of your
`Caddyfile`:

```caddyfile
{
	servers {
		trusted_proxies static 192.0.2.10/32
		trusted_proxies_strict
	}
}
```

Replace `192.0.2.10/32` with your front proxy's address. Without `trusted_proxies_strict`, Caddy logs
the FIRST address in `X-Forwarded-For`, which the visitor writes, so a guesser could get any address
they choose banned. With it, Caddy logs the address your front proxy added, the same one
BudgetPilot counts. Both cases were measured.

## Limits

- **An IPv6 visitor can change address on every attempt.** A home connection usually gets a whole
  block of addresses, so a ban on one address does not stop the next. BudgetPilot's own limit still
  holds, because it counts the block (`BP_RATE_LIMIT_IPV6_PREFIX`).
- **A shared address bans everyone behind it**, such as an office or a mobile carrier. Add
  addresses you trust to fail2ban's `ignoreip`, or to a CrowdSec allowlist, and keep the ban short.
- **Some doors are not marked**: confirming your password in Settings, registration, and invitation
  links. Settings already limits its own attempts per session.
- **The mark reaches the visitor.** Anyone can read the header in the response. It says nothing the
  page does not: the sign-in was refused.

## Results of the tests behind this page

Run on 2026-10-09 against the application built from the change that added this page (#876),
behind Caddy 2.11.7 writing the shipped log format, with 45 sign-in requests from documentation
addresses.

| Tool     | Version | Lines read | Marked lines found | Addresses alerted or banned | Planted checks                                                                                 |
| -------- | ------- | ---------- | ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| fail2ban | 1.1.1   | 46         | 21                 | 1, the one with 5 marks     | The log with marked lines removed matched 0 of 25, and with one marked line put back, 1 of 26. |
| CrowdSec | 1.8.1   | 46         | 21                 | 1, the one with 5 marks     | The same address, from the shipped console format and from `wrap json` with the hub parser.    |

No address that only signed in successfully, or that was refused by the limit, was matched.

To send the application log to a security platform and alert on the pseudonym instead, see
[Send the log to a collector](./logging-collectors.md).
