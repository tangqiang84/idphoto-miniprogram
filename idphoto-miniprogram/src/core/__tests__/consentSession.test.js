'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createConsentSession } = require('../consentSession');
const { buildConsentRecord } = require('../privacy');
test('RC-06授权矩阵：本地、上云、换装和姿态分开，未知动作拒绝', () => {
  for (const tool of ['T1','T2','T3','T4']) {
    assert.equal(buildConsentRecord(tool, [], 'collect').ready, false);
    assert.equal(buildConsentRecord(tool, ['faceLocal'], 'local').ready, true);
  }
  for (const tool of ['T1','T2','T3']) {
    assert.equal(buildConsentRecord(tool, ['faceLocal'], 'cloud').ready, false);
    assert.equal(buildConsentRecord(tool, ['faceLocal','faceCloudEnhance'], 'cloud').ready, true);
  }
  for (const tool of ['T1','T3']) {
    assert.equal(buildConsentRecord(tool, ['faceLocal','suitSwap'], 'suit').ready, true);
    assert.equal(buildConsentRecord(tool, ['faceLocal','suitSwap'], 'pose').ready, false);
    assert.equal(buildConsentRecord(tool, ['faceLocal','suitSwap','faceCloudEnhance'], 'pose').ready, true);
  }
  for (const tool of ['T5','T6']) assert.equal(buildConsentRecord(tool, [], 'collect').ready, true);
  assert.equal(buildConsentRecord('T4', ['faceLocal','faceCloudEnhance'], 'cloud').ready, false);
  assert.equal(buildConsentRecord('UNKNOWN', [], 'collect').ready, false);
  assert.equal(buildConsentRecord('T1', ['faceLocal'], 'unknown').ready, false);
});
test('RC-06撤回再授权不能恢复旧任务，已发出请求只丢弃结果', async () => {
  const a = createConsentSession('T1'); let calls = 0; let release;
  a.update(['faceLocal','faceCloudEnhance']); const token = a.capture('cloud');
  const pending = token.call(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
  a.update(['faceLocal']); a.update(['faceLocal','faceCloudEnhance']); release('late');
  await assert.rejects(pending, { code: 'CONSENT_REVOKED' });
  await assert.rejects(token.call(() => { calls++; }), { code: 'CONSENT_REVOKED' });
  assert.equal(calls, 1); assert.equal(a.capture('cloud').current(), true);
  a.dispose(); assert.equal(a.capture('local').current(), false);
});
