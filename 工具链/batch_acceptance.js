/**
 * 批量真实头像验收（2026-10-27，问题台账 #67 整改落地）
 *
 * 用途：对 `素材/真实头像/` 下全部真实照片逐张跑 T2「单独换底色」全链路
 * （真实 CloudBase 云函数，非 mock），每张抓：
 *   ① 状态行原文（含 backend / 降级标记）
 *   ② [audit] 增量日志（upload_region / cloud_ok / cloud_fail / cloud_degraded_quality 及原因码）
 *   ③ 导出成品 JPG 落盘（供像素判定 + 人工验收）
 *   ④ 页面截图
 * 结果汇总写 results.json，由 工具链/report_acceptance.py 生成 HTML 验收报告。
 *
 * 口径（#67）：本脚本只产出事实，不下「解决」结论；PASS/WARN/FAIL 规则见 report_acceptance.py。
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/batch_acceptance.js [--port 9441] [--dir 素材/真实头像]
 *
 * 前置：微信开发者工具「设置 → 安全设置 → 服务端口」已开启；dist/ 已编译（npm run build:weapp）。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(getArg('--port', 9441));
const IMGDIR = path.resolve(ROOT, getArg('--dir', '素材/真实头像'));
const OUTDIR = path.join(ROOT, '素材', '测试截图', 'acceptance');

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { waitForStatus } = require('./smoke_kit');

// 文件名净化：真实头像里有 "images\ (1).jpeg" 这类含反斜杠/空格/括号的文件名
const safeName = (f) => f.replace(/[\\\/\s()（）]/g, '_').replace(/[^\w.\-一-龥]/g, '_');

(async () => {
  const files = fs.readdirSync(IMGDIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('目录无图片:', IMGDIR); process.exit(2); }
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log(`共 ${files.length} 张待验收: ${files.join(', ')}`);

  const logs = [];
  let miniProgram;
  const results = [];

  try {
    // 优先 launch（拉起/复用项目窗口）；若用户已在开发者工具里开着本项目，launch 会超时 ——
    // 此时该窗口的自动化端口已在 LISTEN，直接 connect 复用（2026-10-27 实测）
    try {
      miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    } catch (e1) {
      console.log('launch 失败（%s），改 connect ws://localhost:%d …', String(e1 && e1.message || e1).slice(0, 60), PORT);
      miniProgram = await automator.connect({ wsEndpoint: `ws://localhost:${PORT}` });
    }
    miniProgram.on('console', (msg) => {
      const parts = (msg.args || []).map((a) => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (_) { return String(a); }
      });
      logs.push(`[${msg.type}] ${parts.join(' ') || msg.text || ''}`);
    });

    // 等首页就绪 → 进 T2 → 勾选全部授权（一次即可，后续换图不掉授权）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    await cards[1].tap();
    await sleep(3000);
    page = await miniProgram.currentPage();
    const items = await page.$$('.consent__item');
    for (const it of items) await it.tap();
    await sleep(300);
    console.log(`授权项 ${items.length} 已全部勾选`);

    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);

    for (let idx = 0; idx < files.length; idx++) {
      const fname = files[idx];
      const rec = { file: fname, idx };
      const logCursor = logs.length;
      try {
        // ① 注入图片（保持原扩展名，canvas 解码按真实格式走）
        const ext = (fname.match(/\.(jpe?g|png)$/i) || [null, '.jpg'])[1].toLowerCase();
        const b64 = fs.readFileSync(path.join(IMGDIR, fname)).toString('base64');
        const target = `${userDataPath}/batch_${idx}${ext === '.png' ? '.png' : '.jpg'}`;
        await miniProgram.evaluate(
          (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
          b64, target,
        );
        await miniProgram.mockWxMethod('chooseImage', {
          tempFilePaths: [target],
          tempFiles: [{ path: target, size: b64.length }],
        });

        // ② 点主按钮 → 等完成/失败
        const btn = await page.$('.btn-primary');
        await btn.tap();
        const st = await waitForStatus(page, ['完成', '失败'], 90);
        rec.status = (st.status || st.pageText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        rec.finished = st.hit;

        // ③ audit 增量日志
        rec.audit = logs.slice(logCursor).filter((l) => l.indexOf('[audit]') >= 0);
        rec.errors = logs.slice(logCursor).filter((l) => l.indexOf('[error]') >= 0);

        // ④ 成品落盘
        const imgs = await page.$$('image');
        let src = null;
        const seen = [];
        for (const el of imgs) {
          try {
            const s = await el.attribute('src');
            seen.push(s);
            if (s && (s.indexOf('http://tmp/') === 0 || s.indexOf('http://usr/') === 0 || s.indexOf('wxfile://') === 0)) { src = s; break; }
          } catch (_) {}
        }
        if (!src && seen.length) src = seen[seen.length - 1];
        if (src) {
          const fileB64 = await miniProgram.evaluate(
            (p) => {
              const fs2 = wx.getFileSystemManager();
              const cands = [];
              if (p.indexOf('http://usr/') === 0) cands.push(p.replace(/^http:\/\/usr\//, wx.env.USER_DATA_PATH + '/'));
              if (p.indexOf('http://tmp/') === 0) {
                cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/../tmp/'));
                cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/'));
              }
              cands.push(p);
              for (const c of cands) { try { return fs2.readFileSync(c, 'base64'); } catch (_) {} }
              throw new Error('readFileSync 失败: ' + p);
            },
            src,
          );
          const outName = safeName(fname.replace(/\.(jpe?g|png)$/i, '')) + '_result.jpg';
          const outPath = path.join(OUTDIR, outName);
          fs.writeFileSync(outPath, Buffer.from(fileB64, 'base64'));
          rec.resultImage = 'acceptance/' + outName;
        } else {
          rec.resultImage = null;
          rec.note = '未抓到预览图 src（seen=' + JSON.stringify(seen).slice(0, 120) + '）';
        }

        // ⑤ 页面截图
        const shotName = safeName(fname.replace(/\.(jpe?g|png)$/i, '')) + '_page.png';
        try {
          await miniProgram.screenshot({ path: path.join(OUTDIR, shotName) });
          rec.pageShot = 'acceptance/' + shotName;
        } catch (_) { rec.pageShot = null; }

        console.log(`[${idx + 1}/${files.length}] ${fname} → ${rec.status.slice(0, 60)}${rec.resultImage ? '（成品已落盘）' : '（无成品）'}`);
      } catch (e) {
        rec.error = String((e && e.message) || e);
        rec.audit = logs.slice(logCursor).filter((l) => l.indexOf('[audit]') >= 0);
        console.log(`[${idx + 1}/${files.length}] ${fname} → 异常: ${rec.error.slice(0, 100)}`);
      }
      results.push(rec);
      // 每 5 张落一次中间结果，防长跑丢数据
      fs.writeFileSync(path.join(OUTDIR, 'results.json'), JSON.stringify(results, null, 2));
    }

    fs.writeFileSync(path.join(OUTDIR, 'results.json'), JSON.stringify(results, null, 2));
    console.log('\n✅ 批量验收数据已写入', path.join(OUTDIR, 'results.json'));
    console.log('下一步: python3 工具链/report_acceptance.py');

    await miniProgram.close();
    process.exit(0);
  } catch (e) {
    console.error('批量验收失败:', e && e.message ? e.message : e);
    fs.writeFileSync(path.join(OUTDIR, 'results.json'), JSON.stringify(results, null, 2));
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
