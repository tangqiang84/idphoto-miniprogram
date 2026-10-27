/**
 * 批量真实头像验收（2026-10-27，问题台账 #67 整改落地；T3 模式 2026-10-27 下午追加）
 *
 * 用途：对 `素材/真实头像/` 下全部真实照片逐张跑工具全链路
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
 *   NODE_OPTIONS= node 工具链/batch_acceptance.js [--port 9441] [--dir 素材/真实头像] [--tool t2|t3]
 *   --tool t2 = 单独换底色（默认）；--tool t3 = AI 换装（换装+换蓝底）
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
const FILES_ARG = getArg('--files', ''); // 子集过滤：--files 111.jpg,123.png（逗号分隔，模糊匹配）
const TOOL = getArg('--tool', 't2').toLowerCase();
const BG_OPT = getArg('--bg', ''); // --bg blue：T2 模式下点「标准深蓝」chip 生成同底色基线（供 T3 差分判定）
const SUBDIR = TOOL === 't3' ? 'acceptance_suit' : (BG_OPT === 'blue' ? 'acceptance_blue' : 'acceptance');
const OUTDIR = path.join(ROOT, '素材', '测试截图', SUBDIR);
const RESULTS_FILE = path.join(OUTDIR, TOOL === 't3' ? 'results_suit.json' : (BG_OPT === 'blue' ? 'results_blue.json' : 'results.json'));
// 首页卡片：T2=1 / T3=2（home/index.tsx TOOLS 顺序）
const CARD_INDEX = TOOL === 't3' ? 2 : 1;
// 各工具完成/失败状态行关键词
const STATUS_HINTS = TOOL === 't3'
  ? ['换装完成', '处理失败', '未检测到', '失败']
  : ['完成', '失败'];

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 automator console 日志里解析 [audit] JSON 对象。
 * 【P1 #78】批量验收需要结构化的换装几何数据（source / rotateDeg / shoulderSpan），
 * 而 console 事件已被 JSON 字符串化 → 这里做括号配平截取 + JSON.parse。
 */
function parseAuditObjects(lines) {
  const out = [];
  for (const l of lines || []) {
    // 注意：console 事件的 args 数组里 '[audit]' 是**字符串参数**（不带引号），
    // 后面跟 JSON.stringify 后的对象 → 标记要按不带引号的形式找（带引号会漏掉整条）
    const idx = l.indexOf('[audit]');
    if (idx < 0) continue;
    const start = l.indexOf('{', idx);
    if (start < 0) continue;
    let depth = 0, end = -1;
    for (let i = start; i < l.length; i++) {
      const c = l[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) {
      try { out.push(JSON.parse(l.slice(start, end + 1))); } catch (e) { /* 忽略坏行 */ }
    }
  }
  return out;
}

/** 肩线贴合度指标：模板旋转角 = 实测肩线夹角（限位 ±15°，达标线 ≤8°） */
const SHOULDER_ANGLE_LIMIT_DEG = 8;

const { waitForStatus } = require('./smoke_kit');

// 文件名净化：真实头像里有 "images\ (1).jpeg" 这类含反斜杠/空格/括号的文件名
const safeName = (f) => f.replace(/[\\\/\s()（）]/g, '_').replace(/[^\w.\-一-龥]/g, '_');

(async () => {
  const files = fs.readdirSync(IMGDIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .filter((f) => {
      if (!FILES_ARG) return true;
      return FILES_ARG.split(',').some((k) => f.indexOf(k.trim()) >= 0);
    })
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
      // 【2026-10-28】launch 必须显式传 IDE 的 HTTP 服务端口，否则 cli 连不上 IDE（9420 被占）
      miniProgram = await automator.launch({
        projectPath: APP, port: PORT, timeout: 60000,
        args: ['--port', String(process.env.IDE_HTTP_PORT || 16780)],
      });
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

    // 等首页就绪 → 进目标工具 → 勾选全部授权（一次即可，后续换图不掉授权）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }
    let page = await miniProgram.currentPage();
    // 【2026-10-28】connect 复用会话时可能停在别的页面 → 先退回首页再点卡片
    let st0 = await miniProgram.pageStack().catch(() => []);
    let guard = 0;
    while (((st0[st0.length - 1] || {}).path || '') !== 'pages/home/index' && guard < 5) {
      try { await miniProgram.navigateBack(); } catch (e) { break; }
      await sleep(1500);
      st0 = await miniProgram.pageStack().catch(() => []);
      guard++;
    }
    page = await miniProgram.currentPage();
    let cards = await page.$$('.tool-card');
    if (!cards.length) {
      // 兜底：首页未渲染出卡片 → 等待后重取一次
      await sleep(3000);
      page = await miniProgram.currentPage();
      cards = await page.$$('.tool-card');
    }
    if (!cards.length) throw new Error('首页工具卡片未渲染（当前页 ' + ((st0[st0.length - 1] || {}).path) + '）');
    await cards[CARD_INDEX].tap();
    await sleep(3000);
    page = await miniProgram.currentPage();
    const items = await page.$$('.consent__item');
    for (const it of items) await it.tap();
    await sleep(300);
    console.log(`[${TOOL}] 授权项 ${items.length} 已全部勾选`);

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
        const st = await waitForStatus(page, STATUS_HINTS, 120);
        rec.status = (st.status || st.pageText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        rec.finished = st.hit;

        // ②b T2 + --bg blue：点「标准深蓝」chip → 只重跑合成（秒级）→ 生成与 T3 同底色基线
        if (TOOL === 't2' && BG_OPT === 'blue') {
          const texts = await page.$$('text');
          for (const t of texts) {
            let s = '';
            try { s = (await t.text()) || ''; } catch (_) {}
            if (s.indexOf('标准深蓝') >= 0) { await t.tap(); break; }
          }
          const st2 = await waitForStatus(page, ['完成'], 30);
          rec.status = (st2.status || rec.status).replace(/\s+/g, ' ').trim().slice(0, 200);
          rec.bg = 'blue';
        }

        // ③ audit 增量日志
        rec.audit = logs.slice(logCursor).filter((l) => l.indexOf('[audit]') >= 0);
        rec.errors = logs.slice(logCursor).filter((l) => l.indexOf('[error]') >= 0);

        // ③b 【P1 #78】换装几何指标：source 分层 + 肩线贴合度（模板旋转角 vs 8° 达标线）
        const auditObjs = parseAuditObjects(rec.audit);
        const fitObj = auditObjs.find((o) => o && o.stage === 'suit_fit_v2' && o.ok !== false);
        const poseObj = auditObjs.find((o) => o && o.stage === 'pose_signal');
        if (poseObj) {
          rec.poseOk = !!poseObj.ok;
          rec.poseReason = poseObj.reason || null;
          rec.poseModel = poseObj.model || null;
        }
        if (fitObj) {
          rec.suitSource = fitObj.source || null;
          rec.shoulderSpan = typeof fitObj.shoulderSpan === 'number' ? Math.round(fitObj.shoulderSpan) : null;
          rec.shoulderAngleDeg = typeof fitObj.rotateDeg === 'number' ? Math.abs(fitObj.rotateDeg) : null;
          rec.shoulderOk = rec.shoulderAngleDeg === null ? null : (rec.shoulderAngleDeg <= SHOULDER_ANGLE_LIMIT_DEG);
          rec.suitWarnings = fitObj.warnings || [];
          rec.suitSpec = fitObj.spec || null;
        } else {
          rec.suitSource = rec.suitSource || null;
          rec.shoulderOk = null;
        }

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
          // 注意：resultImage 前缀必须与 OUTDIR 对应（t3=acceptance_suit / blue=acceptance_blue / 默认 acceptance）——
          // #69 首版硬编码 'acceptance/' 导致 T3 判定脚本读到 T2 的图（误报全覆盖）
          rec.resultImage = SUBDIR + '/' + outName;
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
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    }

    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    // 【P1 #78】分层统计：信号来源分布 + 肩线贴合度达标率
    const bySource = {};
    for (const r of results) {
      const k = r.suitSource || 'none';
      bySource[k] = (bySource[k] || 0) + 1;
    }
    const shoulderTotal = results.filter((r) => r.shoulderOk !== null && r.shoulderOk !== undefined).length;
    const shoulderPass = results.filter((r) => r.shoulderOk === true).length;
    const shoulderFail = results.filter((r) => r.shoulderOk === false).length;
    const summary = {
      total: results.length,
      bySource,
      shoulder: {
        limitDeg: SHOULDER_ANGLE_LIMIT_DEG,
        evaluated: shoulderTotal,
        pass: shoulderPass,
        fail: shoulderFail,
        angles: results.map((r) => ({
          file: r.file,
          source: r.suitSource || null,
          deg: r.shoulderAngleDeg,
          ok: r.shoulderOk,
        })),
      },
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results, summary }, null, 2));
    console.log('\n===== 分层统计（#78）=====');
    console.log('信号来源分布:', JSON.stringify(bySource));
    console.log('肩线贴合度（≤%d°）: 评估 %d / 达标 %d / 超标 %d',
      SHOULDER_ANGLE_LIMIT_DEG, shoulderTotal, shoulderPass, shoulderFail);
    console.log('\n✅ 批量验收数据已写入', RESULTS_FILE);
    console.log('下一步: python3 工具链/report_acceptance.py');

    await miniProgram.close();
    process.exit(0);
  } catch (e) {
    console.error('批量验收失败:', e && e.message ? e.message : e);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
