'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const {assess, required} = require('../rc12_release_gate');

const candidate = {commit:'a'.repeat(40),buildId:'b'.repeat(64),version:'0.1.test'};
const artifact = {path:path.basename(__filename),sha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
const rows = () => required.map(([id,scope]) => ({...candidate,id,scope,status:'PASS',artifact,
  device:{platform:id,model:'fixture',wechat:'fixture',sdk:'fixture'},elapsedMs:1}));

test('RC-12 里程碑按同一候选构建与证据摘要判定', () => {
  assert.equal(assess(candidate,rows(),__dirname).status,'PASS');
  const changed = rows();
  changed[0].buildId = 'c'.repeat(64);
  changed[1].artifact = {...artifact,sha256:'0'.repeat(64)};
  const report = assess(candidate,changed,__dirname);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.rows[0].reason,'CANDIDATE_MISMATCH');
  assert.equal(report.rows[1].reason,'ARTIFACT_MISMATCH');
});

test('RC-12 模拟器不能替代真机，必需跳过与不适用不能过发布门槛', () => {
  const changed = rows();
  changed[4].scope = 'ide';
  delete changed[5].device;
  changed[6].status = 'SKIPPED';
  changed[7].status = 'N/A';
  const report = assess(candidate,changed,__dirname);
  assert.equal(report.status,'BLOCKED');
  assert.equal(report.rows[4].reason,'EVIDENCE_SCOPE_INVALID');
  assert.equal(report.rows[5].reason,'DEVICE_METADATA_MISSING');
  assert.equal(report.counts.SKIPPED,1);
  assert.equal(report.counts['N/A'],1);
});

test('RC-12 缺失、重复和明确失败分别处理', () => {
  assert.equal(assess(candidate,[],__dirname).counts.BLOCKED,required.length);
  assert.throws(()=>assess(candidate,[rows()[0],rows()[0]],__dirname),/RC12_MANIFEST_INVALID/);
  const changed = rows();
  changed[2].status = 'FAIL';
  assert.equal(assess(candidate,changed,__dirname).status,'FAIL');
});
