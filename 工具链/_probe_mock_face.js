/**
 * 探针 v3：绕过 automator.mockWxMethod，直接在 evaluate 内赋值 wx 方法（任务 #24）
 * 验证：faceService 对 wx 的属性读取是「每次调用重新取」→ 直接赋值应生效。
 */
const path = require('path');
const APP = path.join(path.resolve(__dirname, '..'), 'idphoto-miniprogram');
let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mp = await automator.launch({ projectPath: APP, port: 9435, timeout: 60000 });
  mp.on('console', (m) => { const t = (m.text || m.message || ''); if (t) console.log(`  [${m.type}] ${t.slice(0, 160)}`); });
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const st = await mp.pageStack().catch(() => []);
    if ((st[st.length - 1] || {}).path) break;
  }

  const install = await mp.evaluate(() => {
    const r = {};
    try {
      wx.getDeviceInfo = () => ({ brand: 'iPhone', model: 'iPhone 12', platform: 'ios', version: '8.0.30', SDKVersion: '2.30.0' });
      r.device = wx.getDeviceInfo();
    } catch (e) { r.deviceErr = String(e && e.message); }
    try { wx.createVKSession = undefined; r.vk = typeof wx.createVKSession; } catch (e) { r.vkErr = String(e && e.message); }
    try {
      wx.initFaceDetect = (o) => { r.initCalled = true; if (o && o.success) o.success({ errMsg: 'ok' }); };
      wx.faceDetect = (o) => {
        r.fdCalled = true;
        const w = o.width, h = o.height;
        const cx = w / 2, cy = h * 0.42, rx = w * 0.16, ry = h * 0.13;
        const pts = [];
        for (let i = 0; i < 106; i++) { const a = (i / 106) * Math.PI * 2; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }); }
        if (o && o.success) o.success({
          pointArray: pts,
          detectRect: { originX: cx - rx * 1.2, originY: cy - ry * 1.4, width: rx * 2.4, height: ry * 2.8 },
          confArray: { global: 0.9 },
        });
      };
    } catch (e) { r.assignErr = String(e && e.message); }
    return r;
  });
  console.log('INSTALL:', JSON.stringify(install));

  const direct = await mp.evaluate(() => new Promise((resolve) => {
    try {
      wx.initFaceDetect({
        success: () => {
          wx.faceDetect({
            frameBuffer: new ArrayBuffer(4 * 200 * 200), width: 200, height: 200,
            enablePoint: true, enableConf: true,
            success: (r2) => resolve({ ok: true, n: (r2.pointArray || []).length }),
            fail: (e) => resolve({ ok: false, err: e && e.errMsg }),
          });
        },
        fail: (e) => resolve({ ok: false, initFail: e && e.errMsg }),
      });
    } catch (e) { resolve({ ok: false, throw: String(e && e.message) }); }
    setTimeout(() => resolve({ ok: false, timeout: true }), 4000);
  }));
  console.log('DIRECT:', JSON.stringify(direct));

  await mp.close();
  process.exit(direct.ok ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e && e.message); process.exit(3); });