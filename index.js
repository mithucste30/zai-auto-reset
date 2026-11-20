#!/usr/bin/env node
/**
 * zai-quota-guard — quota guard for the z.ai GLM Coding Plan.
 *
 * A long-running, server-side monitor that watches the account's 5-hour token
 * quota and the "reset quota" grants, and auto-consumes the soonest-expiring
 * usable grant when either rule fires:
 *
 *   1. high-usage:    usage percentage >= THRESHOLD_PCT (default 97)
 *   2. expiring-grant: usage below threshold but the soonest usable grant
 *                      expires within EXPIRING_SOON_SEC (default 120s),
 *                      provided usage >= MIN_USAGE_PCT (default 1)
 *
 * Unofficial tool: it talks to the private https://api.z.ai/api endpoints the
 * z.ai web console uses. Those endpoints may change without notice.
 *
 * Zero runtime dependencies. Requires Node >= 18 (global fetch,
 * AbortController). Auth is a Bearer token only (ZAI_TOKEN or --token).
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';
// Overridable for tests / future host changes (must end without a trailing slash).
const API_BASE = process.env.ZAI_API_BASE || 'https://api.z.ai/api';

// --------------------------------------------------------------------------
// Defaults / configuration
// --------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  pollIntervalSec: 60,      // seconds between polls
  expiringSoonSec: 120,     // "expires soon" window for the expiring-grant rule
  thresholdPct: 97,         // high-usage consume threshold
  minUsagePct: 1,           // below this, the expiring-grant rule is skipped
  grantTzOffsetMinutes: 480,// timezone of grant expireTime strings (UTC+8)
  fetchTimeoutMs: 15000,    // per-request timeout (AbortController)
  cooldownSec: 90,          // no rule evaluation after a consume attempt
  tightenPollSec: 15,       // poll interval when a grant expires within tightenWindowSec
  tightenWindowSec: 300,    // 5 minutes
  baseBackoffMs: 5000,      // transient-error backoff base (doubles, capped)
  maxBackoffMs: 300000,     // 5 minutes
  useMaxAttempts: 3,        // retries per consume attempt (same requestId)
});

// --------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// --------------------------------------------------------------------------

/**
 * Parse "YYYY-MM-DD HH:mm:ss" as a wall-clock time at UTC+offsetMinutes
 * (default 480 = Asia/Shanghai, the API's canonical timezone) and return a
 * Date, or null when the input is not a well-formed timestamp.
 * Hand-rolled on purpose: zero dependencies, strict validation.
 */
export function parseGrantTime(str, offsetMinutes = 480) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000);
}

/** Format an epoch-ms instant as ISO 8601 rendered at a fixed offset. */
export function formatAtOffset(ms, offsetMinutes) {
  if (!Number.isFinite(ms)) return 'unknown';
  const d = new Date(ms + offsetMinutes * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const a = Math.abs(offsetMinutes);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

/** Format an epoch-ms instant in the machine's local timezone (ISO 8601). */
export function formatLocalIso(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  return formatAtOffset(ms, -new Date(ms).getTimezoneOffset());
}

/** Human duration: "3d4h", "10h22m", "2m5s", "45s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/**
 * Extract the 5-hour quota from the quota-limit response data.
 * The 5h limit is identified by type === "TOKENS_LIMIT" && unit === 3.
 * Unknown limit types (unit 5 MCP, unit 6 weekly, ...) are ignored.
 * Returns { percentage, nextResetTimeMs } or null when not found/invalid.
 */
export function extractQuota(data) {
  const limits = data && Array.isArray(data.limits) ? data.limits : [];
  const limit = limits.find((l) => l && l.type === 'TOKENS_LIMIT' && l.unit === 3) || null;
  if (!limit) return null;
  const percentage = Number(limit.percentage);
  if (!Number.isFinite(percentage)) return null;
  const nrt = Number(limit.nextResetTime); // epoch milliseconds
  return { percentage, nextResetTimeMs: Number.isFinite(nrt) ? nrt : null };
}

/**
 * Normalize fiveHourResets into a stable shape. `usable` requires
 * available === true AND a parseable expireTime strictly in the future.
 */
export function normalizeGrants(data, nowMs, offsetMinutes = 480) {
  const raw = data && Array.isArray(data.fiveHourResets) ? data.fiveHourResets : [];
  return raw.map((g) => {
    const available = g && g.available === true;
    const expires = parseGrantTime(g && g.expireTime, offsetMinutes);
    const expiresAtMs = expires !== null ? expires.getTime() : null; // epoch ms or null
    const usable = available && expiresAtMs !== null && expiresAtMs > nowMs;
    return {
      recordId: g && g.recordId != null ? g.recordId : null,
      grantType: g && g.grantType != null ? g.grantType : null,
      expireTimeRaw: g && g.expireTime != null ? g.expireTime : null,
      expiresAtMs,
      available,
      usable,
    };
  });
}

/** Usable grants, soonest-expiring first. A grant without recordId cannot be consumed. */
export function usableGrants(normalized) {
  return normalized
    .filter((g) => g.usable && g.recordId != null)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
}

/**
 * The decision function (pure). Input:
 *   quota          { percentage, nextResetTimeMs } | null
 *   usable         array from usableGrants(), soonest first
 *   nowMs          epoch ms
 *   config         overrides on DEFAULTS
 *   cooldownUntilMs  epoch ms until which evaluation is paused
 * Returns { action: 'consume'|'none', kind, rule, grant, reason }.
 */
export function decide({ quota, usable, nowMs, config = {}, cooldownUntilMs = 0 }) {
  const cfg = { ...DEFAULTS, ...config };

  if (nowMs < cooldownUntilMs) {
    return {
      action: 'none', kind: 'cooldown', rule: null, grant: null,
      reason: `cooldown after a previous consume — ${Math.ceil((cooldownUntilMs - nowMs) / 1000)}s left so the refreshed quota becomes visible`,
    };
  }

  const soonest = Array.isArray(usable) && usable.length > 0 ? usable[0] : null;
  if (!soonest) {
    return {
      action: 'none', kind: 'no-usable-grants', rule: null, grant: null,
      reason: 'no usable 5h grants (available=true and expireTime in the future)',
    };
  }

  if (!quota || !Number.isFinite(quota.percentage)) {
    return {
      action: 'none', kind: 'quota-unavailable', rule: null, grant: soonest,
      reason: 'quota state unavailable — fail-safe: no consume decision without the 5h percentage',
    };
  }

  const pct = quota.percentage;

  // Rule 1: high usage.
  if (pct >= cfg.thresholdPct) {
    return {
      action: 'consume', kind: 'high-usage', rule: 'high-usage', grant: soonest,
      reason: `usage ${pct}% >= THRESHOLD_PCT ${cfg.thresholdPct}% — consuming soonest-expiring usable grant #${soonest.recordId}`,
    };
  }

  // Rule 2: grant about to expire.
  const secsLeft = (soonest.expiresAtMs - nowMs) / 1000;
  if (secsLeft <= cfg.expiringSoonSec) {
    if (pct < cfg.minUsagePct) {
      return {
        action: 'none', kind: 'min-usage-guard', rule: null, grant: soonest,
        reason: `grant #${soonest.recordId} expires in ${Math.max(0, Math.round(secsLeft))}s but usage ${pct}% < MIN_USAGE_PCT ${cfg.minUsagePct}% — skipping (resetting a barely-used window is pointless and may be rejected). Set MIN_USAGE_PCT=0 for literal spec behavior`,
      };
    }
    return {
      action: 'consume', kind: 'expiring-grant', rule: 'expiring-grant', grant: soonest,
      reason: `usage ${pct}% < threshold ${cfg.thresholdPct}% but grant #${soonest.recordId} expires in ${Math.max(0, Math.round(secsLeft))}s <= EXPIRING_SOON_SEC ${cfg.expiringSoonSec}s — consuming it rather than letting it lapse`,
    };
  }

  return {
    action: 'none', kind: 'below-threshold', rule: null, grant: soonest,
    reason: `usage ${pct}% < threshold ${cfg.thresholdPct}%; soonest grant expires in ${formatDuration(secsLeft * 1000)} (> ${cfg.expiringSoonSec}s)`,
  };
}

/**
 * Poll delay: tighten to tightenPollSec (15s) when the soonest usable grant
 * expires within tightenWindowSec (5 min), so the expiring-grant rule cannot
 * miss the window. Never longer than the user's POLL_INTERVAL_SEC.
 */
export function nextPollDelayMs({ usable, nowMs, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const normal = cfg.pollIntervalSec * 1000;
  const soonest = Array.isArray(usable) && usable.length > 0 ? usable[0] : null;
  if (!soonest) return normal;
  const msLeft = soonest.expiresAtMs - nowMs;
  if (msLeft > 0 && msLeft <= cfg.tightenWindowSec * 1000) {
    return Math.min(cfg.tightenPollSec * 1000, normal);
  }
  return normal;
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class TransientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransientError';
  }
}

// --------------------------------------------------------------------------
// API client
// --------------------------------------------------------------------------

/**
 * One HTTP call. Auth is the Bearer header only (cookies do not authenticate).
 * Success contract: JSON body with code === 200 && success === true.
 * Throws AuthError for HTTP 401/403 or body code 1001 (verified no-auth shape);
 * throws TransientError for network/timeout/non-JSON responses.
 */
async function apiCall(ctx, path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.fetchTimeoutMs);
  let res;
  let text = '';
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new TransientError(`${method} ${path} network error: ${e && e.message ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const authBodyCode = json && (json.code === 1001 || json.code === 401 || json.code === 403);
  if (res.status === 401 || res.status === 403 || authBodyCode) {
    const detail = json ? `code=${json.code} msg=${JSON.stringify(json.msg)}` : 'non-JSON body';
    throw new AuthError(
      `API rejected the token (HTTP ${res.status}, ${detail}). ` +
      'Provide a valid token via ZAI_TOKEN or --token; cookies do not authenticate this API.'
    );
  }
  if (!json || typeof json !== 'object') {
    throw new TransientError(`${method} ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }

  return {
    ok: json.code === 200 && json.success === true,
    code: json.code,
    msg: json.msg,
    data: json.data != null ? json.data : null,
    httpStatus: res.status,
  };
}

async function fetchQuotaView(ctx) {
  const r = await apiCall(ctx, '/monitor/usage/quota/limit');
  if (!r.ok) {
    throw new TransientError(`quota endpoint returned code=${r.code} msg=${JSON.stringify(r.msg)} (HTTP ${r.httpStatus})`);
  }
  return { quota: extractQuota(r.data), level: r.data && r.data.level != null ? r.data.level : null };
}

async function fetchGrantsView(ctx) {
  const r = await apiCall(ctx, '/biz/customer-package-reset/list?targetType=PERSONAL');
  if (!r.ok) {
    throw new TransientError(`grants endpoint returned code=${r.code} msg=${JSON.stringify(r.msg)} (HTTP ${r.httpStatus})`);
  }
  const nowMs = Date.now();
  const grants = normalizeGrants(r.data, nowMs, ctx.config.grantTzOffsetMinutes);
  return {
    grants,
    usable: usableGrants(grants),
    weekResets: r.data && Array.isArray(r.data.weekResets) ? r.data.weekResets.length : 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consume one grant. `requestId` is the idempotency key: one
 * crypto.randomUUID() per use-attempt, REUSED across transient retries of
 * that attempt and cleared after a terminal result (mirrors the official UI).
 * Returns true on success, false on terminal rejection or exhausted retries.
 */
async function consumeGrant(ctx, grant, rule, reason) {
  const requestId = randomUUID();
  log('use', `rule=${rule} consume recordId=${grant.recordId} grantType=${grant.grantType} requestId=${requestId} — ${reason}`);
  for (let attempt = 1; attempt <= ctx.config.useMaxAttempts; attempt++) {
    try {
      const r = await apiCall(ctx, '/biz/customer-package-reset/use', {
        method: 'POST',
        body: {
          targetType: 'PERSONAL',
          resetType: 'FIVE_HOUR',
          recordId: grant.recordId,
          requestId,
          grantType: grant.grantType,
        },
      });
      if (r.ok) {
        log('use', `recordId=${grant.recordId} requestId=${requestId} consumed (code=200 msg=${JSON.stringify(r.msg)})`);
        return true;
      }
      log('error', `consume rejected (terminal) recordId=${grant.recordId} requestId=${requestId} code=${r.code} msg=${JSON.stringify(r.msg)} — not retrying this attempt`);
      return false;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      log('error', `consume attempt ${attempt}/${ctx.config.useMaxAttempts} failed (transient): ${e.message} — ${attempt < ctx.config.useMaxAttempts ? 'retrying with the SAME requestId (idempotency key)' : 'giving up this attempt'}`);
      if (attempt < ctx.config.useMaxAttempts) await sleep(2000 * attempt);
    }
  }
  return false;
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(tag, msg) {
  const line = `${new Date().toISOString()} [${tag}] ${msg}`;
  if (tag === 'error' || tag === 'fatal') console.error(line);
  else console.log(line);
}

function windowStr(quota) {
  return quota && Number.isFinite(quota.nextResetTimeMs) ? formatLocalIso(quota.nextResetTimeMs) : 'unknown';
}

function describeGrant(g, ctx) {
  const off = ctx.config.grantTzOffsetMinutes;
  const expParts = [];
  if (g.expiresAtMs !== null) {
    expParts.push(formatAtOffset(g.expiresAtMs, off));
    expParts.push(`(raw "${g.expireTimeRaw}")`);
    expParts.push(g.expiresAtMs > Date.now()
      ? `expiresIn=${formatDuration(g.expiresAtMs - Date.now())}`
      : `expired=${formatDuration(Date.now() - g.expiresAtMs)} ago`);
  } else {
    expParts.push(`raw "${g.expireTimeRaw}" (unparseable)`);
  }
  return `recordId=${g.recordId == null ? '?' : g.recordId} grantType=${g.grantType == null ? '?' : g.grantType} available=${g.available} usable=${g.usable} expire=${expParts.join(' ')}`;
}

// --------------------------------------------------------------------------
// Cycle / main loop
// --------------------------------------------------------------------------

async function runCycle(ctx) {
  // 1. quota
  const qv = await fetchQuotaView(ctx);
  let currentQuota = qv.quota;
  if (!currentQuota) {
    log('error', 'quota response did not contain the 5-hour limit (TOKENS_LIMIT unit=3) — rules evaluate as "quota unavailable" this cycle');
  }

  // 2. grants
  const gv = await fetchGrantsView(ctx);
  for (const g of gv.grants) log('grant', describeGrant(g, ctx));
  if (gv.weekResets > 0) log('grant', `weekResets=${gv.weekResets} present — weekly grants are never auto-consumed (out of scope)`);

  // 3. evaluate
  const decision = decide({
    quota: currentQuota,
    usable: gv.usable,
    nowMs: Date.now(),
    config: ctx.config,
    cooldownUntilMs: ctx.cooldownUntilMs,
  });

  // 4. maybe consume (one grant per cycle)
  if (decision.action === 'consume') {
    if (ctx.dryRun) {
      log('use', `dry-run: would consume recordId=${decision.grant.recordId} grantType=${decision.grant.grantType} rule=${decision.rule} — ${decision.reason}`);
    } else {
      const consumed = await consumeGrant(ctx, decision.grant, decision.rule, decision.reason);
      ctx.cooldownUntilMs = Date.now() + ctx.config.cooldownSec * 1000;
      log('use', `cooldown ${ctx.config.cooldownSec}s — rule evaluation paused so the refreshed quota becomes visible`);
      if (consumed) {
        try {
          const re = await fetchQuotaView(ctx);
          if (re.quota) {
            currentQuota = re.quota;
            log('use', `post-consume quota pct=${re.quota.percentage}% windowResetsAt=${windowStr(re.quota)} — reset verified`);
          } else {
            log('error', 'post-consume quota re-fetch succeeded but the 5-hour limit was not found');
          }
        } catch (e) {
          if (e instanceof AuthError) throw e;
          log('error', `post-consume quota re-fetch failed (non-fatal): ${e.message}`);
        }
      }
    }
  } else if (decision.kind !== 'no-usable-grants') {
    log('decide', `action=none kind=${decision.kind} — ${decision.reason}`);
  }

  // 5. one clean status line
  const soonest = gv.usable.length > 0 ? gv.usable[0] : null;
  const bits = [
    `pct=${currentQuota ? `${currentQuota.percentage}%` : '?'}`,
    `windowResetsAt=${windowStr(currentQuota)}`,
    `grants(usable)=${gv.usable.length}${gv.grants.length > 0 ? ` total=${gv.grants.length}` : ''}`,
    soonest
      ? `soonestExpires=${formatAtOffset(soonest.expiresAtMs, ctx.config.grantTzOffsetMinutes)} in=${formatDuration(soonest.expiresAtMs - Date.now())}`
      : 'soonestExpires=none',
  ];
  let delayMs = null;
  if (!ctx.once) {
    delayMs = nextPollDelayMs({ usable: gv.usable, nowMs: Date.now(), config: ctx.config });
    bits.push(`nextPollIn=${Math.round(delayMs / 1000)}s${delayMs < ctx.config.pollIntervalSec * 1000 ? ' (tightened: grant expiring soon)' : ''}`);
  }
  log('poll', bits.join(' '));
  return { delayMs, decision };
}

async function main() {
  let config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(`${new Date().toISOString()} [error] ${e.message}`);
    printUsage();
    return 1;
  }
  if (config.help) {
    printHelp();
    return 0;
  }

  const ctx = {
    config,
    token: config.token,
    once: !!config.once,
    dryRun: !!config.dryRun,
    cooldownUntilMs: 0,
    consecutiveErrors: 0,
  };

  const tz = config.grantTzOffsetMinutes;
  const tzStr = `${tz < 0 ? '-' : '+'}${String(Math.floor(Math.abs(tz) / 60)).padStart(2, '0')}:${String(Math.abs(tz) % 60).padStart(2, '0')}`;
  log('start', `zai-quota-guard v${VERSION} pid=${process.pid} mode=${ctx.once ? 'once' : 'monitor'}${ctx.dryRun ? ' dry-run' : ''} poll=${config.pollIntervalSec}s threshold=${config.thresholdPct}% expiringSoon=${config.expiringSoonSec}s minUsage=${config.minUsagePct}% grantTz=UTC${tzStr} fetchTimeout=${config.fetchTimeoutMs}ms cooldown=${config.cooldownSec}s token=***${config.token.slice(-4)}`);

  let backoffMs = 0;
  for (;;) {
    try {
      const { delayMs } = await runCycle(ctx);
      ctx.consecutiveErrors = 0;
      backoffMs = 0;
      if (ctx.once) {
        log('exit', '--once cycle complete');
        return 0;
      }
      await sleep(delayMs != null ? delayMs : config.pollIntervalSec * 1000);
    } catch (e) {
      if (e instanceof AuthError) {
        log('fatal', `${e.message}`);
        log('exit', 'authentication failed — exiting with code 1 so the supervisor (cron/systemd) can restart with a fresh token');
        return 1;
      }
      ctx.consecutiveErrors += 1;
      backoffMs = backoffMs === 0 ? ctx.config.baseBackoffMs : Math.min(backoffMs * 2, ctx.config.maxBackoffMs);
      log('error', `cycle failed: ${e.message} — consecutiveErrors=${ctx.consecutiveErrors} retryIn=${backoffMs / 1000}s (exponential backoff, cap ${ctx.config.maxBackoffMs / 1000}s)`);
      if (ctx.once) {
        log('exit', '--once cycle failed');
        return 1;
      }
      await sleep(backoffMs);
    }
  }
}

// --------------------------------------------------------------------------
// CLI parsing / help
// --------------------------------------------------------------------------

function parseConfig(argv, env) {
  const config = { ...DEFAULTS };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') config.once = true;
    else if (a === '--dry-run') config.dryRun = true;
    else if (a === '--help' || a === '-h') config.help = true;
    else if (a === '--token') {
      const v = argv[++i];
      if (!v) errors.push('--token requires a value');
      else config.token = v;
    } else if (a.startsWith('--token=')) {
      config.token = a.slice('--token='.length);
    } else {
      errors.push(`unknown argument: ${a}`);
    }
  }

  const num = (envName, key, min, max) => {
    const raw = env[envName];
    if (raw === undefined || raw === '') return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      errors.push(`${envName} must be a number between ${min} and ${max} (got "${raw}")`);
    } else {
      config[key] = v;
    }
  };
  num('POLL_INTERVAL_SEC', 'pollIntervalSec', 5, 86400);
  num('EXPIRING_SOON_SEC', 'expiringSoonSec', 0, 86400);
  num('THRESHOLD_PCT', 'thresholdPct', 0, 100);
  num('MIN_USAGE_PCT', 'minUsagePct', 0, 100);
  num('GRANT_TZ_OFFSET_MINUTES', 'grantTzOffsetMinutes', -720, 840);
  num('FETCH_TIMEOUT_MS', 'fetchTimeoutMs', 1000, 120000);
  num('COOLDOWN_SEC', 'cooldownSec', 0, 3600);

  if (!config.token && env.ZAI_TOKEN) config.token = env.ZAI_TOKEN;

  if (errors.length > 0) throw new Error(`invalid configuration:\n  ${errors.join('\n  ')}`);
  if (!config.help && !config.token) throw new Error('missing auth token: set ZAI_TOKEN or pass --token <token>');
  return config;
}

function printUsage() {
  console.error('Run with --help for the full configuration reference.');
}

function printHelp() {
  console.log(`zai-quota-guard v${VERSION}
Monitors the z.ai GLM Coding Plan 5-hour token quota and auto-consumes the
soonest-expiring usable reset grant when usage is high (>= THRESHOLD_PCT) or
when a grant is about to expire (within EXPIRING_SOON_SEC and usage >=
MIN_USAGE_PCT). Unofficial: uses the private api.z.ai endpoints.

Usage:
  ZAI_TOKEN=<token> node index.js                run forever (monitor mode)
  ZAI_TOKEN=<token> node index.js --once         one poll + decision, then exit
  ZAI_TOKEN=<token> node index.js --once --dry-run   status only, never consumes

Flags:
  --token <token>   Bearer token (alternative to the ZAI_TOKEN env var)
  --once            single poll + decision + exit (exit 1 on auth/cycle failure)
  --dry-run         evaluate and log decisions but never POST /use
  -h, --help        show this help

Environment (all optional except ZAI_TOKEN; invalid values are a hard error):
  ZAI_TOKEN                 Bearer token (required unless --token is given)
  POLL_INTERVAL_SEC         seconds between polls            (default 60, min 5)
  EXPIRING_SOON_SEC         "expires soon" window in seconds (default 120)
  THRESHOLD_PCT             high-usage consume threshold, %  (default 97)
  MIN_USAGE_PCT             minimum usage for the expiring-grant rule, % (default 1;
                            set 0 for literal spec behavior: consume even at 0% usage)
  GRANT_TZ_OFFSET_MINUTES   offset of grant expireTime strings (default 480 = UTC+8,
                            Asia/Shanghai, the API's canonical timezone)
  FETCH_TIMEOUT_MS          per-request timeout              (default 15000)
  COOLDOWN_SEC              no-evaluation cooldown after a consume attempt (default 90)
  ZAI_API_BASE              API base URL (default https://api.z.ai/api; for tests)

Behavior notes:
  - Polling tightens to 15s when the soonest usable grant expires within 5 min.
  - After a successful consume the quota is re-fetched and the new percentage
    logged immediately; rule evaluation then pauses for COOLDOWN_SEC.
  - HTTP 401/403 or API code 1001 => fatal, exit 1 (let your supervisor restart).
  - Transient errors => exponential backoff 5s..300s, keeps running.
  - weekResets (weekly grants) are logged but never auto-consumed.

This script prints [poll] status lines, per-grant [grant] lines, [use] decision
and result lines, and [error] lines — plain text, no colors, log-file friendly.`);
}

// --------------------------------------------------------------------------
// Entry point (only when executed directly, not when imported by tests)
// --------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.on('SIGINT', () => { log('exit', 'SIGINT — shutting down'); process.exit(0); });
  process.on('SIGTERM', () => { log('exit', 'SIGTERM — shutting down'); process.exit(0); });
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      log('fatal', `unexpected failure: ${e && e.stack ? e.stack : String(e)}`);
      process.exit(1);
    });
}
