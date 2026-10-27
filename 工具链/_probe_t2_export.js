/**
 * 一次性诊断探针（2026-10-27，问题：云端精修成品有矩形接缝/背景斑驳）
 *
 * 走 smoke_t2 的完整流程（T2 + test_real.png + 真实云函数链路），
 * 结束后把页面预览图的 src（导出成品 JPG）从模拟器文件系统读出来落盘，
 * 供肉眼检查接缝/噪声。
 *
 * 用法：NODE_OPTIONS= node 工具链/_probe_t2_export.js [--img 素材/测试图/test_real.png] [--port 9431]
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const SHOTS = path.join(ROOT, '素材', '测试截图');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(getArg('--port', 9431));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_real.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { waitForStatus } = require('./smoke_kit');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const logs = [];
  let miniProgram;
  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      const parts = (msg.args || []).map((a) => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (_) { return String(a); }
      });
      logs.push(`[${msg.type}] ${parts.join(' ') || msg.text || ''}`);
    });

    // 等首页就绪（与 smoke_t2 一致：禁 reLaunch，先轮询 pageStack）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }
    // 进 T2
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    await cards[1].tap();
    await sleep(3000);
    page = await miniProgram.currentPage();

    // 勾选授权
    const items = await page.$$('.consent__item');
    for (const it of items) await it.tap();
    await sleep(300);

    // 注入测试图 + mock chooseImage
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/probe_t2.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });

    // 点主按钮 → 等完成
    const btn = await page.$('.btn-primary');
    await btn.tap();
    const st = await waitForStatus(page, ['完成', '失败'], 60);
    console.log('状态行:', (st.status || st.pageText || '').replace(/\s+/g, ' ').slice(0, 120));
    if (!st.hit) throw new Error('处理超时');

    // 抓 audit 日志（上传区域 mode/rect 是本次排障关键证据）
    const audit = logs.filter((l) => l.indexOf('[audit]') >= 0);
    console.log('audit 日志:\n' + (audit.join('\n') || '（未捕获）'));

    // 取预览图 src → 读文件 → 落盘
    const imgs = await page.$$('image');
    let src = null;
    const seen = [];
    for (const el of imgs) {
      try {
        const s = await el.attribute('src');
        seen.push(s);
        if (s && !/^(data:|https?:\/\/(?!usr|tmp))/.test(s) === false) { /* noop */ }
        if (s && (s.indexOf('http://usr/') === 0 || s.indexOf('http://tmp/') === 0 || s.indexOf('wxfile://') === 0)) { src = s; break; }
      } catch (_) {}
    }
    if (!src && seen.length) src = seen[seen.length - 1]; // 兜底：最后一个 image
    console.log('页面 image src 列表:', JSON.stringify(seen));
    if (!src) throw new Error('未找到预览图 src');
    console.log('预览 src:', src);
    const fileB64 = await miniProgram.evaluate(
      (p) => {
        const fs2 = wx.getFileSystemManager();
        // http://usr/ 前缀需还原为 USER_DATA_PATH 真实路径
        const cands = [];
        if (p.indexOf('http://usr/') === 0) cands.push(p.replace(/^http:\/\/usr\//, wx.env.USER_DATA_PATH + '/'));
        if (p.indexOf('http://tmp/') === 0) {
          // devtools 模拟器里 http://tmp/ 与 usr 同级目录
          cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/../tmp/'));
          cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/'));
        }
        cands.push(p);
        for (const c of cands) {
          try { return fs2.readFileSync(c, 'base64'); } catch (_) {}
        }
        throw new Error('readFileSync 全部候选路径失败: ' + cands.join(' | '));
      },
      src,
    );
    const out = path.join(SHOTS, 't2-export-' + Date.now() + '.jpg');
    fs.writeFileSync(out, Buffer.from(fileB64, 'base64'));
    console.log('✅ 成品已落盘: ' + out + '（' + Math.round(fs.statSync(out).size / 1024) + 'KB）');

    await miniProgram.close();
    process.exit(0);
  } catch (e) {
    console.error('探针失败:', e && e.message ? e.message : e);
    const audit = logs.filter((l) => l.indexOf('[audit]') >= 0);
    if (audit.length) console.error('audit 日志:\n' + audit.join('\n'));
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
