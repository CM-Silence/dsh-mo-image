import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 宿主上报的当前版本取自 package.json；发版会改它，所以这里不能写死。
const CURRENT = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// 假 Release 必须比当前版本新，否则检查逻辑会正确地判定"没有更新"。
const NEXT = (() => {
  const [major, minor, patch] = CURRENT.split('-')[0].split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { if (body !== undefined) this.body = String(body); }
  };
}

function jsonReq(method, payload) {
  return {
    method,
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(JSON.stringify(payload));
    }
  };
}

test('the update route reports status and starts an install', async (t) => {  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-update-route-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1,
    providers: [],
    active: { providerId: '', model: '' },
    defaults: {}
  }), 'utf8');
  process.env.DSH_HOME = home;

  const routes = [];
  const installs = [];
  const pluginManager = {
    async listBundles() { return [{ name: 'dsh-mo-image', source: 'github:CM-Silence/dsh-mo-image' }]; },
    async installBundle(spec, options) {
      installs.push({ spec, options });
      return { result: { changed: true, application: 'restart-required' } };
    },
    async removeBundle() { return {}; }
  };
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register() { return () => {}; } },
    webServer: {
      register(route) { routes.push(route); return () => {}; },
      getOrigin() { return 'http://127.0.0.1:1'; }
    },
    systemPrompt: { section() { return () => {}; } },
    skills: { register() { return () => {}; } },
    get(name) { return name === 'pluginManager' ? pluginManager : undefined; }
  };
  const requests = [];
  const mod = await import('../lib/index.js?update-route-test');
  mod.apply(fake, {
    update: {
      request: async (url) => {
        requests.push(String(url));
        if (String(url).includes('/latest')) {
          return { ok: true, async json() { return { version: NEXT }; } };
        }
        return { ok: true, async text() { return `## v${NEXT}\n\n- 新功能\n`; } };
      },
      registryBase: 'http://npm.test',
      mirrorBase: 'http://npm-mirror.test',
      cdnSources: [(version) => `http://cdn.test/${version}/CHANGELOG.md`],
      installDelayMs: 0
    }
  });

  const route = routes.find((item) => item.path === '/api/mo-image/update');
  assert.ok(route, 'missing update route');

  const first = makeRes();
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/update' }, first);
  assert.equal(first.status, 200);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.current, CURRENT);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = makeRes();
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/update' }, second);
  const secondBody = JSON.parse(second.body);
  assert.equal(secondBody.state, 'available');
  assert.equal(secondBody.latest, NEXT);
  assert.equal(secondBody.notes, '- 新功能');
  assert.ok(requests.some((url) => url.includes('/dsh-mo-image/latest')));
  assert.ok(requests.some((url) => url.includes('/CHANGELOG.md')));

  const applyRes = makeRes();
  // 客户端给的版本不可信：服务端只用自己查到的 latest。
  await route.handler(jsonReq('POST', { action: 'apply', version: 'v9.9.9' }), applyRes);
  assert.equal(applyRes.status, 200);
  assert.equal(JSON.parse(applyRes.body).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(installs.length, 1);
  assert.equal(installs[0].spec, `github:CM-Silence/dsh-mo-image#v${NEXT}`);

  const ackRes = makeRes();
  await route.handler(jsonReq('POST', { action: 'ack' }), ackRes);
  assert.equal(ackRes.status, 200);
});

test('a finished update is reported on the first status read after a restart', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-update-done-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, 'mo-image');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, 'config.json'), JSON.stringify({
    version: 1, providers: [], active: { providerId: '', model: '' }, defaults: {}
  }), 'utf8');
  // 上一次更新留下的标记：装的是当前这个版本，说明已经装好了。
  writeFileSync(path.join(state, 'update.json'), JSON.stringify({ from: '0.2.0', to: CURRENT, startedAt: 1 }), 'utf8');
  process.env.DSH_HOME = home;

  const routes = [];
  const fake = {
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {}; },
    inject(_deps, callback) { callback(fake); },
    tools: { register() { return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
    systemPrompt: { section() { return () => {}; } },
    skills: { register() { return () => {}; } },
    get() { return undefined; }
  };
  const mod = await import('../lib/index.js?update-done-test');
  mod.apply(fake, { update: { skipCheck: true } });

  const route = routes.find((item) => item.path === '/api/mo-image/update');
  assert.ok(route);
  const res = makeRes();
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:1' }, url: '/api/mo-image/update' }, res);
  const body = JSON.parse(res.body);
  assert.equal(body.state, 'done');
  assert.equal(body.latest, CURRENT);
  assert.equal(body.updatedBeforeRestart, true);
});
