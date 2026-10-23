/**
 * 探针脚本 · 平台 API 可用性探测（2026-10-23 任务 #24 新增，已登记为项目资产）
 * 目的：确认微信开发者工具模拟器内 wx 人脸检测 API 的可用性，
 *      以决定 T1 自动裁剪能否用 mock 做自动化验证。
 * 用法：NODE_OPTIONS= node 工具链/_probe_face_api.js   （端口 9499）
 * 结论：wx.faceDetect / initFaceDetect / stopFaceDetect / createVKSession /
 *      getDeviceInfo / createOffscreenCanvas 在模拟器内**均为 function**，
 *      但 platform 恒为 'devtools'（faceService 会据此提前返回），
 *      故必须先伪造 getDeviceInfo 才能走检测轨道。
 *      ⚠ mockWxMethod 函数形式对 wx 底层 API 不生效 —— 详见 _probe_mock_face.js 与台账 #33。
 * 详见《项目资产与工具手册.md》3k 节。
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'idphoto-miniprogram');

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules', 'miniprogram-automator'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const miniProgram = await automator.launch({ projectPath: APP, port: 9499, timeout: 60000 });
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const st = await miniProgram.pageStack().catch(() => []);
    if ((st[st.length - 1] || {}).path) break;
  }
  const probe = await miniProgram.evaluate(() => ({
    faceDetect: typeof wx.faceDetect,
    initFaceDetect: typeof wx.initFaceDetect,
    stopFaceDetect: typeof wx.stopFaceDetect,
    createVKSession: typeof wx.createVKSession,
    getDeviceInfo: typeof wx.getDeviceInfo,
    device: typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : null,
    offscreen: typeof wx.createOffscreenCanvas,
  }));
  console.log('PROBE:', JSON.stringify(probe, null, 2));

  // 试 mock
  try {
    await miniProgram.mockWxMethod('getDeviceInfo', function () {
      return { platform: 'ios', version: '8.0.30', SDKVersion: '2.30.0', model: 'iPhone', system: 'iOS 16' };
    });
    const di = await miniProgram.evaluate(() => wx.getDeviceInfo());
    console.log('MOCK getDeviceInfo ->', JSON.stringify(di));
  } catch (e) {
    console.log('MOCK getDeviceInfo FAILED:', e.message);
  }
  try {
    await miniProgram.mockWxMethod('faceDetect', function (opts) {
      if (opts && opts.success) opts.success({ pointArray: [], detectRect: null, confArray: { global: 0.9 } });
    });
    const ok = await miniProgram.evaluate(() => typeof wx.faceDetect);
    console.log('MOCK faceDetect installed ->', ok);
  } catch (e) {
    console.log('MOCK faceDetect FAILED:', e.message);
  }

  await miniProgram.close();
  process.exit(0);
})().catch((e) => {
  console.error('PROBE FAILED:', e && e.message);
  process.exit(3);
});
