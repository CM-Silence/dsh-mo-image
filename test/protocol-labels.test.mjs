/**
 * 协议下拉的文案与顺序。
 *
 * 对话模型设置页的「API 协议」只有三项，句式统一（厂商 + 接口名）、不带括号解释。图像这边
 * 有 17 条协议，同样的观感靠两件事：**短名字**（i18n key protocol.<id>，八语言都在 CSV 里）
 * 与**有逻辑的顺序**（通用 / 官方 → 兼容网关 → 各家原生 → 本地部署 → 异步任务）。
 * 这一组用例守住这两条，顺带守住「分组表覆盖全部协议」——漏一条，它就会掉到下拉最后。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMessages } from '../scripts/build-locales.mjs';
import { PROTOCOL_GROUPS, adapterManifest } from '../lib/adapters.js';

const parsed = parseMessages(readFileSync(new URL('../locale/messages.csv', import.meta.url), 'utf8'));
const BRACKETS = /[(（)）\[\]【】]/;

test('every protocol label is an i18n key of the form protocol.<id>', () => {
  const manifest = adapterManifest();
  assert.equal(manifest.length, 17, '协议数量变了：带括号的长文案例子是按 17 条写的');
  for (const adapter of manifest) {
    assert.equal(adapter.label, 'protocol.' + adapter.id, adapter.id + ' 的 label 要指到自己的文案键');
    assert.ok(parsed.keys.includes(adapter.label), 'locale/messages.csv 缺少 ' + adapter.label);
  }
});

test('协议文案短、不带括号：八种语言逐条检查', () => {
  for (const adapter of adapterManifest()) {
    for (const locale of parsed.locales) {
      const text = parsed.messages[locale][adapter.label];
      assert.ok(text.length > 0, `${locale}:${adapter.label} 是空的`);
      assert.ok(text.length <= 26, `${locale}:${adapter.label} 太长（${text.length} 字符）：${text}`);
      assert.doesNotMatch(text, BRACKETS, `${locale}:${adapter.label} 不该带括号：${text}`);
      assert.equal(text, text.trim(), `${locale}:${adapter.label} 首尾不该有空白`);
    }
  }
});

test('同一语言里没有两条协议用同一个名字', () => {
  for (const locale of parsed.locales) {
    const seen = new Map();
    for (const adapter of adapterManifest()) {
      const text = parsed.messages[locale][adapter.label];
      assert.ok(!seen.has(text), `${locale}: "${text}" 同时给了 ${seen.get(text)} 和 ${adapter.id}`);
      seen.set(text, adapter.id);
    }
  }
});

test('协议顺序：通用 → 兼容网关 → 各家原生 → 本地部署 → 异步任务', () => {
  const manifest = adapterManifest();
  assert.deepEqual(
    [...new Set(manifest.map((item) => item.group))],
    PROTOCOL_GROUPS.map((group) => group.id),
    'adapterManifest 的分组顺序要和 PROTOCOL_GROUPS 一致'
  );
  for (const group of PROTOCOL_GROUPS) {
    assert.deepEqual(
      manifest.filter((item) => item.group === group.id).map((item) => item.id),
      group.adapters,
      '分组 ' + group.id + ' 的协议顺序不对'
    );
  }
  assert.deepEqual(
    manifest.map((item) => item.id).sort(),
    PROTOCOL_GROUPS.flatMap((group) => group.adapters).sort(),
    'PROTOCOL_GROUPS 漏了协议：漏掉的那条会掉到下拉最后'
  );
});

test('分组标题在八种语言里都有文案', () => {
  for (const group of PROTOCOL_GROUPS) {
    const key = 'protocolGroup.' + group.id;
    assert.ok(parsed.keys.includes(key), 'locale/messages.csv 缺少 ' + key);
    for (const locale of parsed.locales) {
      assert.ok(parsed.messages[locale][key].trim().length > 0, `${locale}:${key} 是空的`);
    }
  }
});
