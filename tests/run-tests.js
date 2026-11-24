/**
 * Unit tests for zai-quota-guard's pure decision logic and time parsing.
 * Zero dependencies: node:assert/strict only. Run: node tests/run-tests.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULTS,
  parseGrantTime,
  extractQuota,
  normalizeGrants,
  usableGrants,
  decide,
  nextPollDelayMs,
  formatDuration,
  formatAtOffset,
} from '../index.js';

// Fixed "now" so every case is deterministic: 2026-11-20T12:00:00Z
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

/** Build a grant expireTime string ("YYYY-MM-DD HH:mm:ss") for an instant, in UTC+8 by default. */
function grantStr(msUtc, offset = 480) {
  return formatAtOffset(msUtc, offset).slice(0, 19).replace('T', ' ');
}

/** Grant fixture factory. */
function grant(recordId, expiresAtMs, { available = true, grantType = 'DIRECT', expireTime } = {}) {
  return {
    recordId,
    grantType,
    expireTime: expireTime !== undefined ? expireTime : (expiresAtMs !== undefined ? grantStr(expiresAtMs) : '2026-11-21 00:00:00'),
    available,
  };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------------------------------------------------------------- parseGrantTime

test('parseGrantTime: "2026-11-17 01:26:56" at UTC+8 equals 2026-11-16T17:26:56Z (known instant)', () => {
  const d = parseGrantTime('2026-11-17 01:26:56', 480);
  assert.equal(d.getTime(), Date.UTC(2026, 10, 16, 17, 26, 56));
  assert.equal(d.toISOString(), '2026-11-16T17:26:56.000Z');
});

test('parseGrantTime: offset 0 treats the string as UTC', () => {
  const d = parseGrantTime('2026-11-17 01:26:56', 0);
  assert.equal(d.getTime(), Date.UTC(2026, 10, 17, 1, 26, 56));
});

test('parseGrantTime: negative offset (UTC-5) shifts the other way', () => {
  const d = parseGrantTime('2026-11-17 01:26:56', -300);
  assert.equal(d.getTime(), Date.UTC(2026, 10, 17, 6, 26, 56));
});

test('parseGrantTime: default offset is 480 (UTC+8)', () => {
  assert.equal(parseGrantTime('2026-11-17 01:26:56').getTime(),
    parseGrantTime('2026-11-17 01:26:56', 480).getTime());
});

test('parseGrantTime: rejects garbage, empty, partial, and out-of-range values', () => {
  for (const bad of [
    null, undefined, '', 'garbage', '2026-11-17', '2026-11-17 01:26',
    '2026-13-01 00:00:00', '2026-11-32 00:00:00', '2026-11-17 25:00:00',
    '2026-11-17 23:60:00', '2026-11-17 23:59:60', '2026/11/17 01:26:56',
  ]) {
    assert.equal(parseGrantTime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- formatAtOffset / formatDuration

test('formatAtOffset: renders a UTC instant at +08:00', () => {
  assert.equal(formatAtOffset(Date.UTC(2026, 10, 16, 17, 26, 56), 480), '2026-11-17T01:26:56+08:00');
});

test('formatAtOffset: renders a UTC instant at a negative half-hour offset', () => {
  assert.equal(formatAtOffset(Date.UTC(2026, 10, 17, 6, 26, 56), -300), '2026-11-17T01:26:56-05:00');
});

test('formatDuration: 10h22m, 45s, 2m5s, 1d3h', () => {
  assert.equal(formatDuration((10 * 3600 + 22 * 60) * 1000), '10h22m');
  assert.equal(formatDuration(45 * 1000), '45s');
  assert.equal(formatDuration(125 * 1000), '2m5s');
  assert.equal(formatDuration((24 + 3) * 3600 * 1000), '1d3h');
});

// ---------------------------------------------------------------- extractQuota

test('extractQuota: picks TOKENS_LIMIT unit=3 among other limit types', () => {
  const data = {
    level: 'pro',
    limits: [
      { type: 'TIME_LIMIT', unit: 5, number: 5, percentage: 12, nextResetTime: 1795182218999 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, nextResetTime: 1795182218888 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 2, nextResetTime: 1795182218310 },
      { type: 'SOMETHING_ELSE', unit: 99, percentage: 77 },
    ],
  };
  const q = extractQuota(data);
  assert.equal(q.percentage, 2);
  assert.equal(q.nextResetTimeMs, 1795182218310);
});

test('extractQuota: returns null when the 5h limit is missing or percentage is not a number', () => {
  assert.equal(extractQuota(null), null);
  assert.equal(extractQuota({}), null);
  assert.equal(extractQuota({ limits: [] }), null);
  assert.equal(extractQuota({ limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 'abc' }] }), null);
});

// ---------------------------------------------------------------- normalizeGrants / usableGrants

test('usableGrants: filters available=false, expired, unparseable; sorts soonest-first', () => {
  const data = {
    fiveHourResets: [
      grant(101, NOW + 5 * 3600 * 1000),                       // usable, expires in 5h
      grant(102, NOW + 60 * 1000),                              // usable, expires in 60s (soonest)
      grant(103, NOW + 3600 * 1000, { available: false }),      // not available
      grant(104, NOW - 3600 * 1000),                            // already expired
      grant(105, undefined, { expireTime: 'not-a-date' }),      // unparseable
    ],
  };
  const usable = usableGrants(normalizeGrants(data, NOW, 480));
  assert.deepEqual(usable.map((g) => g.recordId), [102, 101]);
});

test('usableGrants: a grant without recordId is listed but never consumable', () => {
  const data = { fiveHourResets: [grant(null, NOW + 60 * 1000), grant(7, NOW + 120 * 1000)] };
  const usable = usableGrants(normalizeGrants(data, NOW, 480));
  assert.deepEqual(usable.map((g) => g.recordId), [7]);
});

test('usableGrants: empty/missing fiveHourResets behaves like no grants', () => {
  assert.deepEqual(usableGrants(normalizeGrants({}, NOW, 480)), []);
  assert.deepEqual(usableGrants(normalizeGrants(null, NOW, 480)), []);
});

test('normalizeGrants: expiresAtMs is an epoch-ms number (usable in formatAtOffset), not a Date', () => {
  const [g] = normalizeGrants({ fiveHourResets: [grant(400, D(60 * 1000))] }, NOW, 480);
  assert.equal(typeof g.expiresAtMs, 'number');
  assert.ok(Number.isFinite(g.expiresAtMs));
  assert.equal(formatAtOffset(g.expiresAtMs, 480), formatAtOffset(NOW + 60 * 1000, 480));
  const [bad] = normalizeGrants({ fiveHourResets: [grant(401, undefined, { expireTime: 'nope' })] }, NOW, 480);
  assert.equal(bad.expiresAtMs, null);
});

// ---------------------------------------------------------------- decide

const D = (deltaMs) => NOW + deltaMs;

test('decide: multiple usable grants -> picks the SOONEST-expiring one', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [
    grant(101, D(5 * 3600 * 1000)),
    grant(102, D(60 * 1000)),
  ] }, NOW, 480));
  const d = decide({ quota: { percentage: 99, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'consume');
  assert.equal(d.grant.recordId, 102);
});

test('decide: usage >= threshold (exactly 93) triggers high-usage rule', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(201, D(3600 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 93, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'consume');
  assert.equal(d.rule, 'high-usage');
  assert.equal(d.grant.recordId, 201);
});

test('decide: threshold is configurable (50% fires at 50)', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(202, D(3600 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 50, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: { thresholdPct: 50 } });
  assert.equal(d.action, 'consume');
  assert.equal(d.rule, 'high-usage');
});

test('decide: below threshold, grant not expiring -> no action', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(203, D(3600 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 92, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'none');
  assert.equal(d.kind, 'below-threshold');
});

test('decide: below threshold, grant expires within 120s -> expiring-grant rule fires', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(204, D(60 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 50, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'consume');
  assert.equal(d.rule, 'expiring-grant');
  assert.equal(d.grant.recordId, 204);
});

test('decide: boundary — exactly 120s left still fires, 121s does not', () => {
  const mk = (deltaMs) => usableGrants(normalizeGrants({ fiveHourResets: [grant(205, D(deltaMs))] }, NOW, 480));
  const at120 = decide({ quota: { percentage: 50, nextResetTimeMs: NOW }, usable: mk(120 * 1000), nowMs: NOW, config: {} });
  assert.equal(at120.action, 'consume');
  assert.equal(at120.rule, 'expiring-grant');
  const at121 = decide({ quota: { percentage: 50, nextResetTimeMs: NOW }, usable: mk(121 * 1000), nowMs: NOW, config: {} });
  assert.equal(at121.action, 'none');
  assert.equal(at121.kind, 'below-threshold');
});

test('decide: MIN_USAGE_PCT guard — pct 0 with expiring grant is skipped by default', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(206, D(30 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 0, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'none');
  assert.equal(d.kind, 'min-usage-guard');
  assert.match(d.reason, /MIN_USAGE_PCT/);
});

test('decide: MIN_USAGE_PCT=0 gives literal spec behavior (consume at 0% usage)', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(207, D(30 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 0, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: { minUsagePct: 0 } });
  assert.equal(d.action, 'consume');
  assert.equal(d.rule, 'expiring-grant');
});

test('decide: pct 1 (>= default MIN_USAGE_PCT) with expiring grant is consumed', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(208, D(30 * 1000))] }, NOW, 480));
  const d = decide({ quota: { percentage: 1, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'consume');
  assert.equal(d.rule, 'expiring-grant');
});

test('decide: cooldown suppresses everything, even pct 99 + expiring grant', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(209, D(30 * 1000))] }, NOW, 480));
  const d = decide({
    quota: { percentage: 99, nextResetTimeMs: NOW }, usable, nowMs: NOW, config: {},
    cooldownUntilMs: NOW + 60 * 1000,
  });
  assert.equal(d.action, 'none');
  assert.equal(d.kind, 'cooldown');
});

test('decide: no usable grants -> no action', () => {
  const d = decide({ quota: { percentage: 99, nextResetTimeMs: NOW }, usable: [], nowMs: NOW, config: {} });
  assert.equal(d.action, 'none');
  assert.equal(d.kind, 'no-usable-grants');
});

test('decide: quota unavailable -> fail-safe, no action even with an expiring grant', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(210, D(30 * 1000))] }, NOW, 480));
  const d = decide({ quota: null, usable, nowMs: NOW, config: {} });
  assert.equal(d.action, 'none');
  assert.equal(d.kind, 'quota-unavailable');
});

// ---------------------------------------------------------------- nextPollDelayMs

test('nextPollDelayMs: grant expiring within 5 min tightens to 15s', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(301, D(4 * 60 * 1000))] }, NOW, 480));
  assert.equal(nextPollDelayMs({ usable, nowMs: NOW, config: {} }), 15000);
});

test('nextPollDelayMs: boundary — exactly 5 min left tightens, 5:01 does not', () => {
  const mk = (deltaMs) => usableGrants(normalizeGrants({ fiveHourResets: [grant(302, D(deltaMs))] }, NOW, 480));
  assert.equal(nextPollDelayMs({ usable: mk(5 * 60 * 1000), nowMs: NOW, config: {} }), 15000);
  assert.equal(nextPollDelayMs({ usable: mk(301 * 1000), nowMs: NOW, config: {} }), 60000);
});

test('nextPollDelayMs: no usable grants -> normal interval', () => {
  assert.equal(nextPollDelayMs({ usable: [], nowMs: NOW, config: {} }), 60000);
});

test('nextPollDelayMs: never exceeds the user-configured interval (10s stays 10s)', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(303, D(60 * 1000))] }, NOW, 480));
  assert.equal(nextPollDelayMs({ usable, nowMs: NOW, config: { pollIntervalSec: 10 } }), 10000);
});

test('nextPollDelayMs: grant beyond the tighten window -> normal interval', () => {
  const usable = usableGrants(normalizeGrants({ fiveHourResets: [grant(304, D(6 * 60 * 1000))] }, NOW, 480));
  assert.equal(nextPollDelayMs({ usable, nowMs: NOW, config: {} }), DEFAULTS.pollIntervalSec * 1000);
});

// ---------------------------------------------------------------- runner

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} tests passed`);
process.exit(failed > 0 ? 1 : 0);
