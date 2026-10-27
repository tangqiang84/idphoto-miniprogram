// asyncUtils.withTimeout 单测（问题台账 #70）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  withTimeout,
  CLOUD_CALL_TIMEOUT_MS,
  IMG_LOAD_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
} = require('../asyncUtils.js');

test('正常 resolve：值透传、不触发超时', async () => {
  const v = await withTimeout(Promise.resolve(42), 1000, 'x');
  assert.strictEqual(v, 42);
});

test('慢于超时：reject 且错误消息带原因码', async () => {
  const slow = new Promise((r) => setTimeout(() => r('late'), 5000));
  await assert.rejects(
    () => withTimeout(slow, 50, 'cloudfn: 云端响应超时'),
    /cloudfn: 云端响应超时（超时 0s）/,
  );
});

test('原 Promise 先 reject：透传原错误（不被超时消息替换）', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('boom')), 1000, 'cloudfn: 云端响应超时'),
    (e) => e.message === 'boom' && !/超时/.test(e.message),
  );
});

test('原 Promise 成功后定时器被清理（不泄漏、不误报）', async () => {
  // resolve 后立刻再来一个慢 Promise 用同一 code——若上个定时器未清，本进程后续
  // 任何等待都可能被旧定时器误伤；这里用短超时验证快速路径无挂起定时器残留。
  const fast = await withTimeout(Promise.resolve('ok'), 30, 'img: 图片加载超时');
  assert.strictEqual(fast, 'ok');
  await new Promise((r) => setTimeout(r, 60)); // 越过原超时点
  // 定时器已清：此处不应有任何 unhandled rejection（node --test 会报）
});

test('非法入参被拒（防呆）', async () => {
  await assert.rejects(() => withTimeout(null, 1000, 'x'), /入参不是 Promise/);
  await assert.rejects(() => withTimeout(Promise.resolve(1), 0, 'x'), /超时参数非法/);
});

test('超时常量档位合理（云 15s / 图 15s / 导出 20s）', () => {
  assert.strictEqual(CLOUD_CALL_TIMEOUT_MS, 15000);
  assert.strictEqual(IMG_LOAD_TIMEOUT_MS, 15000);
  assert.strictEqual(EXPORT_TIMEOUT_MS, 20000);
});
