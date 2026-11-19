import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfigStore, readConfig } from '../lib/config-store.js';

/**
 * 「未选择协议」的提供商，如果它本来就有预设（`presetId` 在），协议是**已知**的：
 * 预设里写着这条提供商怎么说。读取时补上并写回盘上，别让一份能用的配置长期停在
 * 「未选择」——那个状态是留给用户自配、真的还没选协议的那种。
 *
 * 这里钉住：补什么、什么时候补、以及不该补的（没有来源、或已经有协议的）一个字都不动。
 */

function makeStore(raw) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mo-image-backfill-'));
  const dir = path.join(home, 'mo-image');
  mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify(raw, null, 2), 'utf8');
  const store = createConfigStore({
    configFile,
    ensureDirs() { mkdirSync(dir, { recursive: true }); },
    logHost() {},
    credentialsAccessor() { return null; }
  });
  return { home, configFile, store };
}

const readDisk = (file) => JSON.parse(readFileSync(file, 'utf8'));

function config(provider) {
  return {
    version: 1,
    providers: [Object.assign({
      id: 'p1', name: '火山方舟 Agent Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      models: ['doubao-seedream-4-0-250828'], names: {}
    }, provider)],
    active: { providerId: 'p1', model: 'doubao-seedream-4-0-250828' },
    defaults: {}
  };
}

test('有预设但协议是「未选择」：读取时按 presetId 补上协议，并写回盘上', async (t) => {
  const { home, configFile, store } = makeStore(config({ presetId: 'volcengine-plan', adapter: '', protocol: 'openai-images' }));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const loaded = await readConfig(store);
  assert.equal(loaded.providers[0].adapter, 'openai-images', '预设里的协议就是这条提供商的协议');

  // 「自动保存」：盘上那份也补好了，不是只在内存里。
  const disk = readDisk(configFile);
  assert.equal(disk.providers[0].adapter, 'openai-images', '盘上的 adapter 也补上');
  assert.equal(disk.providers[0].presetId, 'volcengine-plan', '来源照旧');
  assert.equal(disk.providers[0].protocolOptions.edit, 'same', '预设里的协议选项跟着一起来');
});

test('协议已经是具体的：不动盘上的文件', async (t) => {
  const { home, configFile, store } = makeStore(config({ presetId: 'volcengine-plan', adapter: 'openai-images' }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const before = statSync(configFile).mtimeMs;

  await readConfig(store);
  assert.equal(statSync(configFile).mtimeMs, before, '没有要补的东西就不重写');
});

test('没有预设来源、也没选协议：保持「未选择」，不猜也不写盘', async (t) => {
  // 地址与名称都不在任何预设里 = 真的说不出协议：这才是「未选择」该待的地方。
  const { home, configFile, store } = makeStore(config({
    name: 'My relay', baseUrl: 'https://relay.example/v1', adapter: '', protocol: 'openai-images'
  }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const before = statSync(configFile).mtimeMs;

  const loaded = await readConfig(store);
  assert.equal(loaded.providers[0].adapter, '', '自配的提供商说不出协议就是「未选择」');
  assert.equal(statSync(configFile).mtimeMs, before, '也不写盘');
});

test('补过一次就稳定：再读一遍不会再写', async (t) => {
  const { home, configFile, store } = makeStore(config({ presetId: 'volcengine-plan', adapter: '' }));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  await readConfig(store);
  const repaired = statSync(configFile).mtimeMs;
  // 换一个 store（模拟重启）：磁盘上已经是补好的那份，读它不需要再修。
  const restarted = createConfigStore({
    configFile,
    ensureDirs() {},
    logHost() {},
    credentialsAccessor() { return null; }
  });
  const again = await readConfig(restarted);
  assert.equal(again.providers[0].adapter, 'openai-images');
  assert.equal(statSync(configFile).mtimeMs, repaired, '第二次读不再重写');
});

test('老配置把协议 id 记在 protocol 里：一并落到 adapter 并写回', async (t) => {
  const { home, configFile, store } = makeStore(config({ protocol: 'google-gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const loaded = await readConfig(store);
  assert.equal(loaded.providers[0].adapter, 'google-gemini');
  assert.equal(readDisk(configFile).providers[0].adapter, 'google-gemini', '盘上也补好');
});
