'use strict';
// privacy 撤回授权契约单测（PRD I2 / 个保法第 15 条）
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CONSENT_ITEMS,
  TOOL_CONSENTS,
  requiredConsents,
  buildConsentRecord,
  WITHDRAW_METHODS,
  withdrawalNotice,
} = require('../privacy');

test('撤回方式清单：每条都有 id / label / desc / scope', () => {
  assert.ok(Array.isArray(WITHDRAW_METHODS) && WITHDRAW_METHODS.length >= 3);
  for (const m of WITHDRAW_METHODS) {
    assert.strictEqual(typeof m.id, 'string');
    assert.strictEqual(typeof m.label, 'string');
    assert.strictEqual(typeof m.desc, 'string');
    assert.strictEqual(typeof m.scope, 'string');
  }
});

test('撤回方式：覆盖页面内撤回 / 本地清理 / 云端销毁三条路径', () => {
  const ids = WITHDRAW_METHODS.map((m) => m.id);
  assert.ok(ids.includes('pageToggle'));
  assert.ok(ids.includes('localPurge'));
  assert.ok(ids.includes('cloudDestroy'));
});

test('withdrawalNotice：带工具代号时文案点名该工具', () => {
  const n = withdrawalNotice('T3');
  assert.strictEqual(n.title, '如何撤回授权');
  assert.ok(n.body.includes('T3'));
  assert.strictEqual(n.methods.length, WITHDRAW_METHODS.length);
});

test('withdrawalNotice：不带工具代号 → 通用文案，不报错', () => {
  const n = withdrawalNotice();
  assert.strictEqual(n.title, '如何撤回授权');
  assert.ok(n.body.includes('撤回'));
  assert.ok(n.methods.length > 0);
});

test('withdrawalNotice：返回的是副本，外部改动不污染源数据', () => {
  const n = withdrawalNotice('T1');
  n.methods[0].label = '被改了';
  assert.notStrictEqual(WITHDRAW_METHODS[0].label, '被改了');
});

test('既有同意契约零回归：T3 需三项授权且换装须单独授权', () => {
  const need = requiredConsents('T3').map((c) => c.id);
  assert.deepStrictEqual(need, ['faceLocal', 'faceCloudEnhance', 'suitSwap']);
  assert.ok(CONSENT_ITEMS.suitSwap.required === false, '换装是非必需项但需单独授权');
  const rec = buildConsentRecord('T3', ['faceLocal']);
  assert.strictEqual(rec.ready, false);
  assert.deepStrictEqual(rec.missing, ['faceCloudEnhance', 'suitSwap']);
  assert.strictEqual(buildConsentRecord('T3', need).ready, true);
});

test('既有同意契约零回归：TOOL_CONSENTS 覆盖 T1~T5', () => {
  ['T1', 'T2', 'T3', 'T4', 'T5'].forEach((t) => {
    assert.ok(Array.isArray(TOOL_CONSENTS[t]), `${t} 缺同意项配置`);
  });
});
