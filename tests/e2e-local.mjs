/**
 * End-to-end test against a local mock of the z.ai API (no network, no real
 * token). Exercises the full wiring of index.js: quota fetch, grant parsing,
 * decision rules, consume POST body (requestId/recordId/grantType), the
 * post-consume quota re-fetch, dry-run behavior, and the auth-failure exit.
 *
 * Run: node tests/e2e-local.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, '..', 'index.js');
const GOOD_TOKEN = 'good-local-test-token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- mock API

/** Shanghai-wall-clock timestamp string for now + deltaMs. */
function shanghaiStr(deltaMs) {
  const d = new Date(Date.now() + deltaMs + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function startMock({ pct }) {
  const state = { usePosts: [], consumed: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
      send({ code: 1001, msg: 'Authentication parameter not received in Header, unable to authenticate', success: false });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/monitor/usage/quota/limit') {
      send({
        code: 200, msg: 'success', success: true,
        data: {
          level: 'pro',
          limits: [
            { type: 'TIME_LIMIT', unit: 5, number: 5, percentage: 3, nextResetTime: Date.now() + 3600_000 },
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: state.consumed ? 0 : pct, nextResetTime: Date.now() + (state.consumed ? 5 * 3600_000 : 45 * 60_000) },
          ],
        },
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/biz/customer-package-reset/list') {
      send({
        code: 200, msg: 'success', success: true,
        data: {
          customerId: 1, targetType: 'PERSONAL',
          lastFiveHourResetTime: null, lastWeekResetTime: null,
          fiveHourResets: [
            { recordId: 9001, grantType: 'DIRECT', expireTime: shanghaiStr(60 * 1000), available: true },   // soonest
            { recordId: 9002, grantType: 'DIRECT', expireTime: shanghaiStr(6 * 3600 * 1000), available: true },
            { recordId: 9003, grantType: 'DIRECT', expireTime: shanghaiStr(6 * 3600 * 1000), available: false },
            { recordId: 9004, grantType: 'DIRECT', expireTime: shanghaiStr(-3600 * 1000), available: true }, // expired
          ],
          weekResets: [],
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/biz/customer-package-reset/use') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        state.usePosts.push({ headers: req.headers, body: parsed });
        state.consumed = true;
        send({ code: 200, msg: 'success', success: true, data: true });
      });
      return;
    }
    send({ code: 404, msg: 'not found', success: false });
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => resolveReady({ server, state }));
  });
}

/**
 * Spawn `node index.js --once ...` asynchronously (NOT spawnSync: a sync spawn
 * blocks this process's event loop, and the mock server would never accept
 * the child's HTTP connection).
 */
function runOnce(env, args) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [INDEX, '--once', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(killer); rejectDone(e); });
    child.on('close', (code) => { clearTimeout(killer); resolveDone({ code, out, err }); });
  });
}

// ---------------------------------------------------------------- scenarios

const results = [];
const scenario = async (name, fn) => {
  try {
    await fn();
    results.push([name, null]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, e]);
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message.split('\n').join('\n      ')}`);
  }
};

await scenario('e2e: high usage (98%) in dry-run -> logs decision, never POSTs /use', async () => {
  const { server, state } = await startMock({ pct: 98 });
  try {
    const { code, out } = await runOnce({ ZAI_TOKEN: GOOD_TOKEN, ZAI_API_BASE: `http://127.0.0.1:${server.address().port}/api` }, ['--dry-run']);
    assert.equal(code, 0, `exit code ${code}\nstdout:\n${out}`);
    assert.match(out, /\[grant\] recordId=9001 .*usable=true/);
    assert.match(out, /\[use\] dry-run: would consume recordId=9001 .*rule=high-usage/);
    assert.match(out, /\[poll\] pct=98% windowResetsAt=\S+ grants\(usable\)=2 total=4 soonestExpires=\S+\+08:00 in=/);
    assert.equal(state.usePosts.length, 0, 'dry-run must not POST /use');
  } finally {
    server.close();
  }
});

await scenario('e2e: high usage (98%) live -> consumes SOONEST grant, correct POST body, post-consume pct logged', async () => {
  const { server, state } = await startMock({ pct: 98 });
  try {
    const { code, out } = await runOnce({ ZAI_TOKEN: GOOD_TOKEN, ZAI_API_BASE: `http://127.0.0.1:${server.address().port}/api` }, []);
    assert.equal(code, 0, `exit code ${code}\nstdout:\n${out}`);
    assert.equal(state.usePosts.length, 1, 'exactly one consume POST expected');
    const body = state.usePosts[0].body;
    assert.equal(body.targetType, 'PERSONAL');
    assert.equal(body.resetType, 'FIVE_HOUR');
    assert.equal(body.recordId, 9001, 'must consume the soonest-expiring usable grant');
    assert.equal(body.grantType, 'DIRECT');
    assert.match(body.requestId, UUID_RE, 'requestId must be a uuid');
    assert.match(out, /\[use\] recordId=9001 .*consumed \(code=200 msg="success"\)/);
    assert.match(out, /\[use\] cooldown 90s/);
    assert.match(out, /\[use\] post-consume quota pct=0% .*— reset verified/);
  } finally {
    server.close();
  }
});

await scenario('e2e: below threshold + grant expiring in 60s -> expiring-grant rule fires in dry-run', async () => {
  const { server, state } = await startMock({ pct: 50 });
  try {
    const { code, out } = await runOnce({ ZAI_TOKEN: GOOD_TOKEN, ZAI_API_BASE: `http://127.0.0.1:${server.address().port}/api` }, ['--dry-run']);
    assert.equal(code, 0, `exit code ${code}\nstdout:\n${out}`);
    assert.match(out, /rule=expiring-grant/);
    assert.equal(state.usePosts.length, 0);
  } finally {
    server.close();
  }
});

await scenario('e2e: below MIN_USAGE_PCT + grant expiring -> guard skips and logs why', async () => {
  const { server } = await startMock({ pct: 0 });
  try {
    const { code, out } = await runOnce({ ZAI_TOKEN: GOOD_TOKEN, ZAI_API_BASE: `http://127.0.0.1:${server.address().port}/api` }, ['--dry-run']);
    assert.equal(code, 0, `exit code ${code}\nstdout:\n${out}`);
    assert.match(out, /kind=min-usage-guard/);
    assert.doesNotMatch(out, /rule=/);
  } finally {
    server.close();
  }
});

await scenario('e2e: bad token -> clean fatal auth message, exit 1', async () => {
  const { server } = await startMock({ pct: 50 });
  try {
    const { code, out, err } = await runOnce({ ZAI_TOKEN: 'wrong-token', ZAI_API_BASE: `http://127.0.0.1:${server.address().port}/api` }, ['--dry-run']);
    assert.equal(code, 1, `exit code ${code}`);
    assert.match(err, /\[fatal\] API rejected the token .*code=1001/);
    assert.doesNotMatch(out, /\[use\]/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------- summary

const failed = results.filter(([, e]) => e).length;
console.log(`\n${results.length - failed}/${results.length} e2e scenarios passed`);
process.exit(failed > 0 ? 1 : 0);
