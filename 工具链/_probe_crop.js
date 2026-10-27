'use strict';
/**
 * 一次性探针：查交互裁剪区在真机 DOM 里的实际状态（2026-10-28 P2.5 排查）
 * 用途：区分「movable-view 根本没渲染」与「渲染了但被盖住/尺寸为 0」。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const { connectAutomator } = require('./automator_connect');
const { waitForStatus } = require('./smoke_kit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const PORT = Number(process.argv[2] || 9441);
  const mp = await connectAutomator({ projectPath: APP, port: PORT, timeout: 60000 });
  const errors = [];
  mp.on('console', (m) => { if (m.type === 'error') errors.push(m.text || m.message || ''); });

  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const st = await mp.pageStack().catch(() => []);
    if ((st[st.length - 1] || {}).path) break;
  }
  const page = await mp.currentPage();
  const cards = await page.$$('.tool-card');
  await cards[0].tap();
  await sleep(3000);
  const p2 = await mp.currentPage();
  const items = await p2.$$('.consent__item');
  for (const it of items) await it.tap();
  await sleep(500);

  const img = path.join(ROOT, '素材', '测试图', 'test_standard.png');
  const b64 = fs.readFileSync(img).toString('base64');
  const udp = await mp.evaluate(() => wx.env.USER_DATA_PATH);
  const target = `${udp}/probe_crop.png`;
  await mp.evaluate((d, p) => { wx.getFileSystemManager().writeFileSync(p, d, 'base64'); }, b64, target);
  await mp.mockWxMethod('chooseImage', { tempFilePaths: [target], tempFiles: [{ path: target, size: b64.length }] });

  const btn = await p2.$('.btn-primary');
  await btn.tap();
  await waitForStatus(p2, ['完成', '失败'], 90);

  for (const sel of ['.crop-stage', '.crop-stage__img', '.crop-box', '.crop-box__mask', '.crop-zoom', '.crop-apply']) {
    const els = await p2.$$(sel);
    if (!els.length) { console.log(sel, '→ 不存在'); continue; }
    for (const el of els) {
      const style = await el.attribute('style').catch(() => '');
      const cls = await el.attribute('class').catch(() => '');
      console.log(sel, '→ class=', cls, '| style=', String(style).slice(0, 160));
    }
  }
  console.log('运行时错误:', errors.length, errors.slice(0, 3).join(' | '));
  await mp.disconnect().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('探针失败:', e && e.message ? e.message : e); process.exit(3); });
