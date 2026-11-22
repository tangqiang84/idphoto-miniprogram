'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessingSession } = require('../processingSession');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const source = { path: 'fixture://image', width: 1200, height: 1600 };
function ready(options = {}) {
  const session = createProcessingSession({ logger() {}, ...options });
  session.update({ source }); session.confirmCrop();
  return session;
}
test('会话统一保存参数，改美颜/底色/换装/dpi保留确认的原图裁剪', async () => {
  const session = ready();
  session.update({ cropWindow: { x: 120, y: 220, w: 500, h: 700 } }); session.confirmCrop();
  const crop = session.getState().params.cropWindow;
  for (const change of [
    { beauty: { enabled: true, smooth: 0.2, whiten: 0.1, brighten: 0.1 } },
    { bg: 'blue' }, { suit: { enabled: true, templateId: 'navy' } }, { dpi: 600 },
  ]) {
    await session.execute('process', async () => ({ preview: 'fixture://old' })); session.confirmSelfCheck(true);
    assert.equal(session.update(change).ok, true);
    const next = session.getState();
    assert.deepEqual(next.params.cropWindow, crop);
    assert.equal(next.params.cropConfirmed, true);
    assert.equal(next.output, null); assert.equal(next.selfChecked, false);
  }
  session.dispose();
});
test('换规格须新比例再确认，换照片清除旧结果和图像相关参数', async () => {
  const session = ready();
  await session.execute('process', async () => ({ preview: 'old' }));
  session.update({ specId: 'visa-us' });
  assert.equal(session.getState().params.cropConfirmed, false);
  assert.equal(session.getState().params.cropWindow.w, session.getState().params.cropWindow.h);
  let calls = 0;
  assert.equal((await session.execute('process', async () => { calls++; })).error.code, 'SESSION_CROP_REQUIRED');
  assert.equal(calls, 0);
  session.confirmCrop();
  session.update({ suit: { enabled: true, templateId: 'navy' } });
  session.update({ source: { ...source, path: 'fixture://new' } });
  assert.equal(session.getState().sourceId, 2);
  assert.equal(session.getState().params.cropConfirmed, false);
  assert.equal(session.getState().params.suit.enabled, false);
  assert.equal(session.getState().output, null);
  session.dispose();
});
test('并发重复点击只发一次，旧异步不能覆盖新结果或启动下一平台调用', async () => {
  const session = ready(); const old = deferred(); let calls = 0;
  const pending = session.execute('process', async (ctx) => { await ctx.call(() => old.promise); calls++; return { preview: 'old' }; });
  await Promise.resolve();
  assert.equal(session.confirmCrop().error.code, 'SESSION_BUSY');
  assert.equal((await session.execute('process', async () => { calls++; })).error.code, 'SESSION_BUSY');
  session.update({ bg: 'red' });
  await session.execute('process', async () => ({ preview: 'new' }));
  old.resolve();
  assert.equal((await pending).ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(session.getState().output.preview, 'new');
  session.dispose();
});
test('取消能调用平台中止回调，未支持中止的平台返回也不能进入下游', async () => {
  const session = ready(); const wait = deferred(); let aborted = 0; let uploads = 0;
  const pending = session.execute('process', async (ctx) => {
    ctx.onCancel(() => { aborted++; }); await ctx.call(() => wait.promise);
    return ctx.call(() => { uploads++; });
  });
  await Promise.resolve(); session.cancel();
  assert.equal((await pending).ok, false); assert.equal(aborted, 1);
  wait.resolve(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploads, 0); assert.equal(session.getState().status, 'cancelled');
  assert.equal((await session.execute('process', async () => ({ preview: 'retry' }))).ok, true);
  session.dispose();
});
test('撤回授权使在途结果失效，旧任务不得再上传', async () => {
  const session = ready(); session.update({ consents: ['faceLocal', 'faceCloudEnhance'] });
  const wait = deferred(); let upload = 0;
  const pending = session.execute('process', async (ctx) => { await ctx.call(() => wait.promise); return ctx.call(() => { upload++; }); });
  await Promise.resolve(); session.update({ consents: ['faceLocal'] }); wait.resolve();
  assert.equal((await pending).ok, false); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upload, 0); session.dispose();
});
test('超时恢复可重试，迟到结果被丢弃；日志不暴露原异常', async () => {
  const logs = []; const session = ready({ timeoutMs: 10, logger: (meta) => logs.push(meta) });
  const wait = deferred();
  const outcome = await session.execute('process', async (ctx) => ctx.call(() => wait.promise));
  assert.equal(outcome.error.code, 'SESSION_TIMEOUT'); assert.equal(session.getState().status, 'error');
  assert.equal((await session.execute('process', async () => ({ preview: 'new' }))).ok, true);
  wait.resolve({ preview: 'late' }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.getState().output.preview, 'new'); assert.ok(logs[0].traceId);
  const failed = await session.execute('process', async () => { throw new Error('sensitive-payload'); });
  assert.equal(failed.error.code, 'SESSION_PROCESS_FAILED');
  assert.equal(JSON.stringify(logs).includes('sensitive-payload'), false);
  assert.equal(failed.error.message.includes('sensitive-payload'), false);
  session.dispose();
});
test('参数无效不破坏旧会话，快照修改不回写源状态，离页后不能继续', async () => {
  const session = ready(); const revision = session.getState().revision;
  for (const change of [{ dpi: 0 }, { specId: 'unknown' }, { beauty: { enabled: true, slim: 1 } }, { cropWindow: null }]) assert.equal(session.update(change).ok, false);
  assert.equal(session.getState().revision, revision);
  const snapshot = session.getState(); snapshot.params.source.path = 'changed';
  assert.equal(session.getState().params.source.path, source.path);
  const wait = deferred(); const pending = session.execute('process', async (ctx) => ctx.call(() => wait.promise));
  await Promise.resolve(); session.dispose(); wait.resolve();
  assert.equal((await pending).ok, false);
  assert.equal((await session.execute('process', async () => null)).error.code, 'SESSION_DISPOSED');
});
test('未确认裁剪只允许本地建议任务，建议不算成品成功且不能替代确认', async () => {
  const session = createProcessingSession({ logger() {} }); session.update({ source });
  const result = await session.execute('crop-suggestion', async () => ({ sx: 20, sy: 30, sw: 400, sh: 560 }));
  assert.equal(result.ok, true); assert.equal(session.getState().status, 'crop');
  assert.equal(session.getState().output, null); assert.equal(session.getState().params.cropConfirmed, false);
  assert.equal((await session.execute('process', async () => null)).error.code, 'SESSION_CROP_REQUIRED');
  session.dispose();
});

test('RC-11 超时和授权错误使用固定文案，诊断失败不阻止恢复', async () => {
  const session = ready({ tool: 'T3', logger() { throw Error('observer'); } });
  const timeout = await session.execute('preview', async () => { throw {code:'ASYNC_TIMEOUT', message:'private_photo'}; });
  assert.equal(timeout.error.code, 'SESSION_TIMEOUT');
  assert.equal(timeout.error.retryable, true);
  assert.match(timeout.error.traceId, /^T3-/);
  const denied = await session.execute('preview', async () => { throw {code:'CONSENT_REVOKED', message:'private_token'}; });
  assert.equal(denied.error.code, 'SESSION_CONSENT');
  assert.equal(denied.error.retryable, false);
  assert.doesNotMatch(JSON.stringify([timeout,denied]), /private_/);
  assert.equal(session.getState().status, 'error');
});

test('RC-11 离页清空照片和成品引用，旧调用只带自己的 TraceID 结束', async () => {
  const session = ready();
  session.update({consents:['faceLocal']});
  const wait = deferred();
  const pending = session.execute('preview', (ctx) => ctx.call(() => wait.promise));
  const traceId = session.getState().traceId;
  await Promise.resolve();
  session.dispose();
  const state = session.getState();
  assert.equal(state.params.source, null);
  assert.equal(state.params.cropWindow, null);
  assert.deepEqual(state.params.consents, []);
  assert.equal(state.output, null);
  wait.resolve({preview:'late'});
  assert.equal((await pending).error.traceId, traceId);
  assert.equal(session.getState().output, null);
});
