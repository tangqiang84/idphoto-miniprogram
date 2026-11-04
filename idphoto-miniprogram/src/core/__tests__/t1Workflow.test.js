'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessingSession } = require('../processingSession');
const { createT1Workflow } = require('../t1Workflow');
function setup() {
  const session = createProcessingSession({ logger() {} }); const calls = [];
  let n = 0;
  const adapters = { suggest: async () => null, process: async (task, mode) => {
    calls.push({ mode, params: task.params, sourceId: task.sourceId });
    return { preview: 'fixture://' + ++n, isFinal: mode === 'final', suitApplied: task.params.suit.enabled,
      result: { checks: ['dimension', 'dpi', 'bg', 'filesize'].map((key) => ({ key, label: key, pass: true, level: 'required' })) } };
  } };
  const flow = createT1Workflow(session, adapters);
  flow.update({ consents: ['faceLocal'] });
  flow.selectImage({ path: 'fixture://source', width: 1200, height: 1600 });
  return { session, flow, calls, adapters, dispose() { flow.dispose(); session.dispose(); } };
}
async function preview(s) { s.flow.confirmCrop(); await s.flow.confirmBeauty(true); }
async function dpi(s) { await preview(s); s.flow.nextDress(); await s.flow.skipSuit(); s.flow.goDpi(); s.flow.confirmMirror(true); }
test('逐步门禁：裁剪仅进入美颜，美颜确认前无处理，档位确认前无最终成品', async () => {
  const s = setup();
  assert.equal((await s.flow.export()).ok, false); assert.equal(s.calls.length, 0);
  s.flow.confirmCrop(); assert.equal(s.flow.getState().screen, 'beauty'); assert.equal(s.calls.length, 0);
  await s.flow.confirmBeauty(true); assert.equal(s.flow.getState().screen, 'preview');
  assert.deepEqual(s.calls.map((v) => v.mode), ['preview']);
  assert.equal(s.calls[0].params.beauty.enabled, false);
  assert.equal(s.flow.exportResult(s.session.getState().traceId).ok, false);
  s.flow.nextDress(); await s.flow.skipSuit(); s.flow.goDpi();
  assert.equal((await s.flow.export()).ok, false, '未确认镜像不可最终输出');
  s.flow.confirmMirror(true); await s.flow.export();
  assert.equal(s.flow.getState().screen, 'export'); assert.equal(s.calls.at(-1).mode, 'final');
  assert.equal(s.flow.exportResult(s.session.getState().traceId).ok, true); s.dispose();
});
test('返回保留裁剪/美颜/底色/档位；改规格使后续确认失效', async () => {
  const s = setup(); await dpi(s); const crop = s.session.getState().params.cropWindow;
  s.flow.setDpi(600); s.flow.back(); assert.equal(s.flow.getState().screen, 'check');
  assert.equal(s.flow.goDpi().ok, true); assert.equal(s.session.getState().params.dpi, 600);
  assert.deepEqual(s.session.getState().params.cropWindow, crop);
  s.flow.update({ specId: 'visa-us' }); assert.equal(s.flow.getState().screen, 'crop');
  assert.equal((await s.flow.export()).ok, false); assert.equal(s.session.getState().params.cropConfirmed, false); s.dispose();
});
test('换装可跳过；换装后及最终重新生成后须对当前结果自检', async () => {
  const s = setup(); await preview(s); s.flow.nextDress();
  assert.equal((await s.flow.applySuit()).ok, false);
  s.flow.update({ consents: ['faceLocal', 'suitSwap'] }); await s.flow.applySuit();
  assert.equal(s.flow.getState().pendingSelf, true);
  assert.equal(s.flow.acceptSelfCheck().ok, false);
  s.flow.confirmSelfCheck(true); s.flow.acceptSelfCheck(); s.flow.goDpi(); s.flow.confirmMirror(true);
  await s.flow.export(); assert.equal(s.flow.getState().pendingSelf, true);
  assert.equal(s.flow.exportResult(s.session.getState().traceId).ok, false);
  s.flow.confirmSelfCheck(true); s.flow.acceptSelfCheck();
  const old = s.session.getState().traceId; assert.equal(s.flow.exportResult(old).ok, true);
  s.flow.confirmSelfCheck(false); assert.equal(s.flow.exportResult(old).ok, false); s.dispose();
});
test('过期任务/回调不可导出；失败可重试，硬指标失败不给成品', async () => {
  const s = setup(); await dpi(s);
  const real = s.adapters.process; let failed = false;
  s.adapters.process = async (task, mode) => { if (!failed) { failed = true; throw new Error('private'); } return real(task, mode); };
  assert.equal((await s.flow.export()).ok, false); await s.flow.retry();
  const old = s.session.getState().traceId;
  s.flow.back(); s.flow.setDpi(300); await s.flow.export();
  assert.equal(s.flow.exportResult(old).ok, false);
  s.flow.back(); s.adapters.process = async (task, mode) => ({ ...(await real(task, mode)), result: { checks: [{ key: 'filesize', label: '大小', pass: false, level: 'required' }] } });
  assert.equal((await s.flow.export()).ok, false); assert.equal(s.flow.getState().screen, 'dpi'); s.dispose();
});
