# zai-quota-guard

A standalone, zero-dependency Node.js monitor for the **z.ai GLM Coding Plan**.
It watches the account's 5-hour token quota and the "reset quota" grants, and
automatically consumes a grant when it makes sense — so grants never expire
unused and you never hit the 97% wall mid-session.

> **Unofficial tool.** It talks to the private `https://api.z.ai/api` endpoints
> that the z.ai web console itself uses. Those endpoints can change without
> notice. Auth is a Bearer token only (cookies do **not** authenticate this API).

Requires Node >= 18 (uses the global `fetch` and `AbortController`). No npm
runtime dependencies.

## What it does

Every poll cycle the script fetches the quota state and the grant list, logs a
full status line, and evaluates two consume rules:

1. **High-usage rule** — if the 5-hour usage percentage is `>= THRESHOLD_PCT`
   (default 97) and at least one usable grant exists, it consumes the
   **soonest-expiring** usable grant.
2. **Expiring-grant rule** — if usage is below the threshold but the
   soonest-expiring usable grant expires within `EXPIRING_SOON_SEC`
   (default 120 s), it consumes it anyway (an expired grant is a wasted grant),
   **unless** usage is below `MIN_USAGE_PCT` (see the trade-off below).

A **usable** grant is an entry in `fiveHourResets` with `available === true`
and an `expireTime` strictly in the future.

After a successful consume the script immediately re-fetches the quota and
logs the new percentage (proof the reset worked), then pauses rule evaluation
for `COOLDOWN_SEC` (default 90 s) so the refreshed quota is visible before any
new decision. At most one grant is consumed per cycle.

Polling automatically tightens: when the soonest usable grant expires within
5 minutes, the poll interval drops to 15 s so the 2-minute rule cannot miss
the window; otherwise it polls at `POLL_INTERVAL_SEC`.

## Quick start

```sh
# status only, no writes — safe first run
ZAI_TOKEN="your-bearer-token" node index.js --once --dry-run

# single poll + decision (consumes if a rule fires), then exit — for cron
ZAI_TOKEN="your-bearer-token" node index.js --once

# long-running monitor — for systemd / tmux / a server
ZAI_TOKEN="your-bearer-token" node index.js
```

Getting a token: open the z.ai console in a browser, grab the `Authorization:
Bearer ...` header from any request to `api.z.ai` in devtools, and use the
token value. Treat it like a password.

## Configuration reference

Configuration is via environment variables; the token can also be passed as a
flag. Invalid values are a hard error at startup — a state-changing bot should
not silently fall back to defaults.

| Env var | Flag | Default | Meaning |
|---|---|---|---|
| `ZAI_TOKEN` | `--token <t>` | (required) | Bearer token for `api.z.ai` |
| `POLL_INTERVAL_SEC` | — | `60` | Seconds between polls (min 5) |
| `EXPIRING_SOON_SEC` | — | `120` | Grant counts as "expiring soon" within this many seconds |
| `THRESHOLD_PCT` | — | `97` | High-usage consume threshold, percentage |
| `MIN_USAGE_PCT` | — | `1` | Minimum usage for the expiring-grant rule (see below) |
| `GRANT_TZ_OFFSET_MINUTES` | — | `480` | Offset of grant `expireTime` strings (480 = UTC+8, Asia/Shanghai) |
| `FETCH_TIMEOUT_MS` | — | `15000` | Per-request timeout (AbortController) |
| `COOLDOWN_SEC` | — | `90` | No-evaluation cooldown after a consume attempt |
| `ZAI_API_BASE` | — | `https://api.z.ai/api` | API base URL (override for tests / host changes) |
| — | `--once` | off | One poll + decision + exit (exit 1 on auth or cycle failure) |
| — | `--dry-run` | off | Log decisions but never POST `/use` |
| — | `--help` / `-h` | — | Full built-in reference |

## The MIN_USAGE_PCT trade-off

The official UI disables the "Use" button when the 5-hour percentage is 0:
resetting an untouched window is pointless and may be rejected server-side.
The literal spec ("consume a grant that is about to expire regardless of
usage") can therefore waste a grant on a fresh window.

The default `MIN_USAGE_PCT=1` resolves this in the UI's favor: when usage is
below 1%, the expiring-grant rule is **skipped** and the reason is logged:

```
2026-11-20T12:00:00.000Z [decide] action=none kind=min-usage-guard — grant #2714921 expires in 42s but usage 0% < MIN_USAGE_PCT 1% — skipping (resetting a barely-used window is pointless and may be rejected). Set MIN_USAGE_PCT=0 for literal spec behavior
```

If you want the literal spec behavior (consume an expiring grant even at 0%
usage), set `MIN_USAGE_PCT=0`.

## Logging

Plain text, ISO timestamps, no colors — log-file friendly. `[error]` and
`[fatal]` go to stderr, everything else to stdout.

```
2026-11-20T12:00:00.000Z [start] zai-quota-guard v1.0.0 pid=123 mode=monitor poll=60s threshold=97% expiringSoon=120s minUsage=1% grantTz=UTC+08:00 fetchTimeout=15000ms cooldown=90s token=***abcd
2026-11-20T12:00:00.000Z [grant] recordId=2714920 grantType=DIRECT available=false usable=false expire=2026-11-17T01:26:56+08:00 (raw "2026-11-17 01:26:56") expired=3d10h ago
2026-11-20T12:00:00.000Z [grant] recordId=2714921 grantType=DIRECT available=true usable=true expire=2026-11-21T01:26:56+08:00 (raw "2026-11-21 01:26:56") expiresIn=10h22m
2026-11-20T12:00:00.000Z [poll] pct=2% windowResetsAt=2026-11-20T19:43:38+06:00 grants(usable)=1 total=2 soonestExpires=2026-11-21T01:26:56+08:00 in=10h22m nextPollIn=60s
```

Window-reset timestamps are displayed in the machine's **local** timezone.
Grant expiries keep the API's raw Shanghai strings and are additionally shown
converted (at `GRANT_TZ_OFFSET_MINUTES`) and in local time.

Consume decisions and results:

```
2026-11-20T12:00:15.000Z [use] rule=high-usage consume recordId=2714921 grantType=DIRECT requestId=6f1c... — usage 97% >= THRESHOLD_PCT 97% — consuming soonest-expiring usable grant #2714921
2026-11-20T12:00:16.000Z [use] recordId=2714921 requestId=6f1c... consumed (code=200 msg="success")
2026-11-20T12:00:16.000Z [use] cooldown 90s — rule evaluation paused so the refreshed quota becomes visible
2026-11-20T12:00:17.000Z [use] post-consume quota pct=0% windowResetsAt=2026-11-20T23:59:59+06:00 — reset verified
```

### Idempotency (requestId)

`POST /biz/customer-package-reset/use` takes a `requestId` idempotency key.
Like the official UI, the script generates one `crypto.randomUUID()` per
use-attempt, reuses it across transient retries of that attempt (network
error / timeout / 5xx — up to 3 tries), and clears it after a terminal result.
A later consume attempt gets a fresh `requestId`.

## Timezones

`expireTime` strings (`"YYYY-MM-DD HH:mm:ss"`) are parsed as wall-clock time
at UTC+8 (Asia/Shanghai, the API's canonical timezone) by default. If the API
ever reports a different canonical timezone, override with
`GRANT_TZ_OFFSET_MINUTES` (e.g. `0` for UTC, `-300` for UTC-5). The parser is
hand-rolled and strict — unparseable timestamps make the grant unusable but
never crash the loop.

## Robustness / exit codes

- **Auth failure** (HTTP 401/403, or API body `code 1001` "no auth" / `code 401`
  "token expired or incorrect"): clear fatal message, exit code `1`. Let
  cron/systemd restart the process with a fresh token.
- **Transient failures** (network, timeout, 5xx, non-JSON): exponential
  backoff 5 s → 10 s → ... capped at 5 min; keeps running.
- **Unexpected limit types / missing fields**: ignored or shown as `?`/`unknown`;
  never crashes. If the 5-hour limit itself cannot be found, rules evaluate as
  "quota unavailable" and **no grant is consumed** (fail-safe).
- Exit `0`: normal shutdown (SIGINT/SIGTERM), successful `--once` cycle.
- Exit `1`: missing/invalid config, auth failure, `--once` cycle failure,
  unexpected crash (wrapper restarts).

## Weekly grants are out of scope

`weekResets` grants also reset the 5-hour window, but consuming them
automatically is **not** implemented — they reset the weekly quota too and
that is a bigger decision than this bot should make. They are counted and
logged (`weekResets=N present — weekly grants are never auto-consumed`) so you
can consume one manually from the z.ai console.

## Running under systemd

```ini
# ~/.config/systemd/user/zai-quota-guard.service
[Unit]
Description=z.ai GLM Coding Plan quota guard
After=network-online.target

[Service]
Environment=ZAI_TOKEN=your-bearer-token
# Environment=THRESHOLD_PCT=95 EXPIRING_SOON_SEC=180
ExecStart=/usr/bin/node /path/to/zai-quota-guard/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

`systemctl --user enable --now zai-quota-guard` and `journalctl --user -u
zai-quota-guard -f` to watch. Alternatively a cron one-shot:

```cron
*/5 * * * * ZAI_TOKEN=... /usr/bin/node /path/to/zai-quota-guard/index.js --once >> ~/.zai-quota-guard.log 2>&1
```

(The `--once` mode still consumes when a rule fires — cron at 5-minute
intervals can miss a 2-minute expiry window; prefer the long-running monitor
or tighten the cron schedule.)

## Tests

```sh
npm test            # unit + end-to-end (below)
npm run check       # node --check on all sources
```

Two suites, zero dependencies, no real API calls:

- `tests/run-tests.js` — unit tests of the pure functions: the decision rules
  (threshold, expiring-grant, MIN_USAGE_PCT guard, cooldown, fail-safes),
  grant filtering/ordering, the UTC+8 timestamp parser, and poll-tightening.
- `tests/e2e-local.mjs` — spins up a local mock of the three z.ai endpoints and
  runs `index.js --once` against it (dry-run and live), verifying the consume
  POST body (`targetType`/`resetType`/`recordId`/uuid `requestId`/`grantType`),
  the post-consume quota re-fetch log, and the auth-failure exit path. Set
  `ZAI_API_BASE` to point the script elsewhere.

## Security notes

- The token is passed via an environment variable or `--token`; `--token` is
  visible in process listings (`ps`), so prefer `ZAI_TOKEN` on shared machines.
- The script only ever reads quota/grant state and POSTs the grant-consume
  endpoint; it performs no other writes and sends no telemetry anywhere.
