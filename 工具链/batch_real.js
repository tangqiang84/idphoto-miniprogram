'use strict';
/**
 * 真实素材 × 关键工具 全链路业务验收（batch + 业务断言）
 * ============================================================================
 * 【为什么有这个文件】
 * 现有 工具链/batch_acceptance.js 已经能用真实头像跑通 T2/T3 并落盘成品，
 * 但它只验**连通性**（状态行出现「完成」就算过）—— 这正是 owner 批评的
 * 「假绿」。本脚本在它的基础上：
 *   1. 覆盖 **T1 一键证件照 / T2 换底色 / T3 换装** 三个关键工具；
 *   2. 每个成品都跑 **工具链/assert_business.js 的业务断言**（像素尺寸/底色/
 *      头占比/文件大小/水印/五官不变/脸部干净）；
 *   3. 报告里**严格区分两个数字**：
 *        · 连通性通过 = 链路跑完且拿到成品（不生成即失败）；
 *        · 业务断言通过 = 上述业务断言全绿。
 *      两者**不合并成一个「通过」**。
 *
 * 【复用既有套路，不重写】（任务要求）
 *   · IDE 连接  → 工具链/automator_connect.js 的 connectAutomator（不重复造轮子）
 *   · 页面跳转  → 与 batch_acceptance.js 同款：首页点卡片（禁 reLaunch）
 *   · 图片注入  → 写入 USER_DATA_PATH + mockWxMethod('chooseImage')
 *   · 状态等待  → 工具链/smoke_kit.js 的 waitForStatus（只认 .status-line）
 *
 * 【成品落盘】
 *   素材/测试截图/real_batch/<素材名>/<工具>/
 *       original.<ext>   原图副本（便于人工复核）
 *       result.jpg       成品
 *       page.png         页面截图
 *       assertions.json  该组合的断言结果（含每条的判定依据）
 *   汇总：素材/测试截图/real_batch/results.json
 *
 * 【已知坑（问题台账 #86/#87）】
 *   「timeout waiting for automator response」= IDE 通道没开，不是脚本失败。
 *   本脚本的处理：① 用 cli auto 手动开通道 → ② 重试 connect → ③ 记录重试次数，
 *   **不因为这个报错就判定脚本失败**。
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/batch_real.js
 *   NODE_OPTIONS= node 工具链/batch_real.js --tools t1,t2 --files 111.jpg,123.png
 *   NODE_OPTIONS= node 工具链/batch_real.js --port 9441 --purpose positive
 *   NODE_OPTIONS= node 工具链/batch_real.js --help
 *
 * 退出码：0 = 全部连通性通过（业务断言失败不算退出码非 0，见 --strict）；
 *         1 = --strict 且有业务断言失败；2 = 用法/环境错误；3 = IDE 通道始终连不上
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const OUT_ROOT = path.join(ROOT, '素材', '测试截图', 'real_batch');

const { connectAutomator, portFree, sleep, detectIdeAutoPort } = require('./automator_connect');
const { waitForStatus, readStatus } = require('./smoke_kit');
const A = require('./assert_business');
const { pickRealImages, listRealAssets, syntheticNoticeFor } = require('./real_assets');

const IDE_CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const hasArg = (k) => args.includes(k);

if (hasArg('--help') || hasArg('-h')) {
  console.log(`真实素材 × 关键工具 全链路业务验收

用法:
  node 工具链/batch_real.js [选项]

选项:
  --tools <列表>      要跑的工具，逗号分隔：t1,t2,t3（默认 t1,t2,t3）
  --files <列表>      只跑指定素材（文件名子集，逗号分隔）
  --purpose <用途>    positive | negative-cartoon | negative-landscape | lowres（默认：正例+低分辨率，不含负例）
  --negatives         连负例一起跑
  --limit <n>         最多跑几张
  --port <n>          automator ws 端口（默认 9441；需空闲）
  --spec <specId>     断言用规格（默认 one-inch）
  --dpi <n>           断言用 dpi（默认 300）
  --bg <#RRGGBB>      期望底色（默认 #FFFFFF；T3 默认蓝底 #438EDB）
  --out <目录>        成品输出目录（默认 素材/测试截图/real_batch）
  --strict            兼容保留（退出码已恒定反映业务断言结果，此开关不再改变行为）
  --keep-going        单张失败继续跑（默认：继续）
  --no-ide            只跑断言（对已有成品重新断言，不连 IDE）

说明:
  · 默认输入是 素材/真实头像/ 的**真实照片**（见 工具链/real_assets.js）。
  · 报告严格区分「连通性通过数」与「业务断言通过数」，不合并成一个「通过」。
  · IDE 通道连不上会自动用 cli auto 开通道重试（问题台账 #86/#87），并打印重试次数。

退出码:
  0 = 连通性全通过 **且** 业务断言全绿
  1 = 连通性有失败（链路未通）
  4 = 连通性全通过，但**业务断言有失败**（真实产品问题）
  2 = 用法错误；3 = IDE 通道连不上（环境问题，不算业务失败）`);
  process.exit(0);
}

const TOOLS_RAW = getArg('--tools', 't1,t2,t3').toLowerCase();
const TOOLS = TOOLS_RAW.split(',').map((s) => s.trim()).filter(Boolean);
const SPEC_ID = getArg('--spec', 'one-inch');
const DPI = Number(getArg('--dpi', 300));
const BG = getArg('--bg', '');
const OUT_DIR = path.resolve(ROOT, getArg('--out', '素材/测试截图/real_batch'));
// --strict 保留为兼容别名：退出码已恒定反映「连通性/业务断言」两个维度，
// 不再需要靠开关决定「失败算不算失败」。
const STRICT = hasArg('--strict');
const NO_IDE = hasArg('--no-ide');
const PORT = Number(getArg('--port', 9441));

// 工具 → 首页卡片下标（home/index.tsx 的 TOOLS 顺序：T1..T6）
const TOOL_CARDS = { t1: 0, t2: 1, t3: 2 };
// 工具 → 各工具的状态关键词（只认 .status-line，避免展示文案污染）
const TOOL_STATUS = {
  t1: ['完成', '失败', '处理失败'],
  t2: ['完成', '失败', '处理失败'],
  t3: ['换装完成', '未换装', '处理失败', '失败'],
};
// 工具 → 期望底色（T3 默认蓝底；T1/T2 默认白底）
const TOOL_BG = { t1: '#FFFFFF', t2: '#FFFFFF', t3: '#438EDB' };

/**
 * 各工具的**规格口径**（不同工具的默认输出规格不同，断言必须按工具区分，否则会误判）：
 *   · T1：默认选中第一个规格（一寸），按规格像素出图 → 用 spec 断言
 *   · T2：默认**不选规格**（保持原图尺寸），输出尺寸 = 原图按长边≤800 等比缩放
 *        → 不能拿一寸像素去断言；改为断言「长边≤800 且与原图宽高比一致」
 *   · T3：默认选中第一个规格（一寸）→ 用 spec 断言
 * 说明：T2 的规格口径见 idphoto-miniprogram/src/pages/tool-bg/index.tsx 的 specIndex=-1
 *      （台账 #81 记为「T2 是否强制规格待拍板」——本脚本按**现状**断言，不臆测未来行为）。
 */
const TOOL_SPEC_MODE = { t1: 'spec', t2: 'keep-original', t3: 'spec' };

/**
 * T2「保持原图尺寸」路径的期望输出尺寸。
 * 口径与产品实现一致（pages/tool-bg/index.tsx：scale = min(1, 800/max(srcW,srcH))）。
 */
function expectedKeepOriginalSize(srcW, srcH) {
  const scale = Math.min(1, 800 / Math.max(srcW, srcH));
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/** 文件名净化（含空格/括号的真实素材名要安全落盘） */
const safeName = (f) => f.replace(/[\\\/\s()（）]/g, '_').replace(/[^\w.\-一-龥]/g, '_').replace(/^\.+/, '_');

/** 解析素材清单 */
function resolveAssets() {
  const opts = {};
  if (getArg('--purpose', '')) opts.purpose = getArg('--purpose');
  if (getArg('--files', '')) opts.files = getArg('--files');
  if (hasArg('--negatives')) opts.includeNegatives = true;
  if (getArg('--limit', '')) opts.limit = Number(getArg('--limit'));
  let list = pickRealImages(opts);
  if (!list.length) {
    console.error('⚠ 按条件没有匹配到任何真实素材，改为使用全部真实素材');
    list = pickRealImages({ includeNegatives: true });
  }
  return list;
}

// ---------------------------------------------------------------- IDE 连接
/**
 * 连接 IDE 自动化通道，含「cli auto 开通道 → 重试」逻辑（问题台账 #86/#87）。
 * 返回 { miniProgram, retries } —— retries 为重试次数（用于如实报告）。
 */
async function connectWithRecovery() {
  let retries = 0;
  const idePort = String(process.env.IDE_HTTP_PORT || 16780);

  // 复用 automator_connect 的 connectAutomator（内部已含 launch/connect/cli auto 回退）
  try {
    const mp = await connectAutomator({ projectPath: APP, port: PORT, timeout: 60000, retries: 2 });
    return { miniProgram: mp, retries };
  } catch (e1) {
    retries++;
    console.log(`  · 首次连接失败（${String(e1 && e1.message || e1).slice(0, 60)}）→ 用 cli auto 手动开通道后重试（第 ${retries} 次重试）`);
  }

  // 显式 cli auto 开通道 → 再 connect（#86/#87 的已知解法）
  try {
    const free = await portFree(PORT);
    if (!free) {
      console.log(`  · 端口 ${PORT} 被占用 → 改用 ${PORT + 1}`);
      const mp = await connectAutomator({ projectPath: APP, port: PORT + 1, timeout: 60000, retries: 2 });
      return { miniProgram: mp, retries };
    }
    execSync(`"${IDE_CLI}" auto --project "${APP}" --auto-port ${PORT} --port ${idePort}`,
      { encoding: 'utf8', stdio: 'ignore', timeout: 90000 });
    console.log(`  · 已执行 cli auto --auto-port ${PORT} --port ${idePort}，等待 IDE 回连…`);
    await sleep(6000);
    const automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
    const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` });
    return { miniProgram: mp, retries };
  } catch (e2) {
    retries++;
    console.log(`  · cli auto + connect 仍失败（${String(e2 && e2.message || e2).slice(0, 60)}）→ 第 ${retries} 次重试，改用 automator.launch`);
    const mp = await connectAutomator({ projectPath: APP, port: PORT + 1, timeout: 90000, retries: 1 });
    return { miniProgram: mp, retries };
  }
}

/**
 * 等小程序页面栈就绪。
 * 【为什么必须等】connect 成功 ≠ IDE 侧 webview 已就绪。
 *   刚连上就调 currentPage()/pageStack()，IDE 内部 getPageMetaByWebviewId 会返回 null
 *   → 抛「Cannot destructure property 'rawPath' ... as it is null」。
 *   故这里轮询等待，失败只重试不判定业务失败（属环境时序问题）。
 * @returns {{ok:boolean, path:string|null, attempts:number}}
 */
async function waitForAppReady(mp, attempts = 12) {
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    await sleep(2000);
    try {
      const st = await mp.pageStack();
      if (st && st.length) {
        const p = await mp.currentPage();
        return { ok: true, path: (p && p.path) || null, attempts: i + 1 };
      }
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 80);
    }
  }
  return { ok: false, path: null, attempts, lastErr };
}

/**
 * 回首页（connect 复用会话时可能停在别的页面）。
 * 注意：automator 0.13 的 navigateBack 在某些会话下会抛
 *   「Cannot destructure property 'rawPath' of 't.getPageMetaByWebviewId(...)' as it is null」
 *   —— 这是 IDE 侧 getPageMetaByWebviewId 返回 null 导致的**会话状态问题**，
 *   不是业务失败。故：每一步都包 try/catch，逐级降级（navigateBack → 直接点首页卡片），
 *   且不把这里的异常当成「验收失败」，只当作「需要重新进入工具页」。
 */
async function gotoHome(mp) {
  let guard = 0;
  try {
    let st = await mp.pageStack();
    while (((st[st.length - 1] || {}).path || '') !== 'pages/home/index' && guard < 5) {
      try { await mp.navigateBack(); } catch (e) { break; }
      await sleep(1500);
      st = await mp.pageStack().catch(() => []);
      guard++;
    }
  } catch (e) {
    // navigateBack 链路不可用 → 忽略，交给下面的兜底
  }
  // 兜底：直接用 currentPage + 首页卡片（点卡片是本项目唯一可靠的导航方式）
  let page = await mp.currentPage();
  const stNow = await mp.pageStack().catch(() => []);
  const onHome = ((stNow[stNow.length - 1] || {}).path || '') === 'pages/home/index';
  if (!onHome) {
    // 尝试从当前页再返回一次（静默失败则放弃，用现有 page 里的卡片兜底）
    try { await mp.navigateBack(); await sleep(1500); } catch (e) { /* ignore */ }
    page = await mp.currentPage();
  }
  return page;
}

/** 把本地图片写入小程序沙箱并 mock chooseImage */
async function injectImage(mp, absPath, idx) {
  const ext = (path.extname(absPath) || '.jpg').toLowerCase();
  const b64 = fs.readFileSync(absPath).toString('base64');
  const userDataPath = await mp.evaluate(() => wx.env.USER_DATA_PATH);
  const target = `${userDataPath}/real_${idx}${ext === '.png' ? '.png' : '.jpg'}`;
  await mp.evaluate(
    (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
    b64, target,
  );
  await mp.mockWxMethod('chooseImage', {
    tempFilePaths: [target],
    tempFiles: [{ path: target, size: b64.length }],
  });
  return target;
}

/**
 * 抓成品：优先取预览图（http://tmp/ 或 wxfile://），读出 base64。
 * 注意：$$ 是 **Page** 上的方法（mp.$$ 不存在）—— 必须传 page 进来。
 */
async function grabProduct(mp, page) {
  const imgs = await page.$$('image');
  const seen = [];
  let src = null;
  for (const el of imgs) {
    try {
      const s = await el.attribute('src');
      seen.push(s);
      if (s && (s.indexOf('http://tmp/') === 0 || s.indexOf('wxfile://') === 0)) { src = s; break; }
    } catch (e) { /* ignore */ }
  }
  if (!src) {
    for (const el of imgs) {
      try {
        const s = await el.attribute('src');
        if (s && s.indexOf('http://usr/') === 0) { src = s; break; }
      } catch (e) { /* ignore */ }
    }
  }
  if (!src && seen.length) src = seen[seen.length - 1];
  if (!src) return null;
  const fileB64 = await mp.evaluate(
    (p) => {
      const fs2 = wx.getFileSystemManager();
      const cands = [];
      if (p.indexOf('http://usr/') === 0) cands.push(p.replace(/^http:\/\/usr\//, wx.env.USER_DATA_PATH + '/'));
      if (p.indexOf('http://tmp/') === 0) {
        cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/../tmp/'));
        cands.push(p.replace(/^http:\/\/tmp\//, wx.env.USER_DATA_PATH + '/'));
      }
      cands.push(p);
      for (const c of cands) { try { return fs2.readFileSync(c, 'base64'); } catch (e) {} }
      throw new Error('readFileSync 失败: ' + p);
    },
    src,
  );
  return { src, base64: fileB64 };
}

/** 抓 [audit] 日志（解析出结构化对象） */
function parseAuditObjects(lines) {
  const out = [];
  for (const l of lines || []) {
    const idx = l.indexOf('[audit]');
    if (idx < 0) continue;
    const start = l.indexOf('{', idx);
    if (start < 0) continue;
    let depth = 0;
    let end = -1;
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

// ---------------------------------------------------------------- 业务断言
/**
 * 读页面上的「智能裁切」信息（T1/T3 的 .crop-info 元素）。
 * 用途：判断**人脸检测是否可用** —— 开发者工具模拟器不支持人脸检测
 *   （idphoto-miniprogram/src/services/faceService.ts 明确跳过 devtools 平台），
 *   此时裁切降级为「按画面居中裁剪」，头占比**必然**不落在规格区间。
 *   这属于**环境限制**，不是产品缺陷 → 报告须把它与真实业务失败区分开。
 * @returns {{text:string, faceDetected:boolean}}
 */
async function readCropInfo(page) {
  let text = '';
  try {
    const el = await page.$('.crop-info');
    if (el) text = ((await el.text()) || '').replace(/\s+/g, ' ').trim();
  } catch (e) { /* ignore */ }
  if (!text) {
    try {
      const texts = await page.$$('text');
      const parts = [];
      for (const t of texts) {
        let s = '';
        try { s = (await t.text()) || ''; } catch (e) { /* ignore */ }
        if (s.indexOf('智能裁切') >= 0 || s.indexOf('未检出人脸') >= 0) parts.push(s);
      }
      text = parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch (e) { /* ignore */ }
  }
  const faceDetected = text.indexOf('未检出人脸') < 0 && text.indexOf('已按目标头部占比') >= 0;
  return { text, faceDetected: faceDetected || text.indexOf('智能裁切：已按目标头部占比') >= 0 };
}

/**
 * 取「换装前参考图」路径。
 * 口径：T3（换装）与 T1（不换装）走**同一条共享管线**（services/pipeline.ts）、
 *      同一规格与 dpi → 裁剪几何一致，两图逐像素对齐 → 可直接比对脸部像素。
 *      故用同素材的 T1 成品作 T3 的参考图。
 * @returns {string|null} 参考图绝对路径；不存在则返回 null
 */
function referenceFor(tool, asset) {
  if (tool !== 't3') return null;
  const p = path.join(OUT_DIR, safeName(asset.file), 't1', 'result.jpg');
  return fs.existsSync(p) ? p : null;
}

/**
 * 对一张成品跑业务断言。
 * @param {string} file 成品路径
 * @param {object} o { specId, dpi, bgHex, maxKb, advisory, sizeMode, srcSize }
 *        sizeMode: 'spec'（按规格像素断言）| 'keep-original'（按原图缩放尺寸断言）
 */
function runBusinessAssertions(file, o) {
  const results = [];
  const spec = require(path.join(APP, 'src', 'core', 'specLibrary.js')).getSpec(o.specId);
  if (o.sizeMode === 'keep-original' && o.srcSize) {
    const exp = expectedKeepOriginalSize(o.srcSize.width, o.srcSize.height);
    results.push({
      name: 'assertPixelSize',
      ...A.assertPixelSize(file, null, o.dpi, {
        expectedWidth: exp.width, expectedHeight: exp.height,
        expectedLabel: `保持原图尺寸（长边≤800 等比缩放，原图 ${o.srcSize.width}×${o.srcSize.height}）`,
      }),
    });
  } else {
    results.push({ name: 'assertPixelSize', ...A.assertPixelSize(file, o.specId, o.dpi) });
  }
  if (o.bgHex) {
    results.push({ name: 'assertBackgroundColor', ...A.assertBackgroundColor(file, o.bgHex, 12) });
  }
  if (spec) {
    results.push({ name: 'assertFileSize', ...A.assertFileSize(file, spec.maxKb, { advisory: !!o.advisory }) });
  }
  results.push({ name: 'assertHeadRatio', ...A.assertHeadRatio(file, o.specId, 0) });
  results.push({ name: 'assertNoWatermark', ...A.assertNoWatermark(file) });
  results.push({ name: 'assertFaceRegionClean', ...A.assertFaceRegionClean(file) });
  // 换装专属：盖脸判定（PRD D2 / AC6）—— 只对走换装路径的工具生效
  // 优先用「换装前参考图 + 换装后图」的肤色保持率口径（归因干净）；
  // 没有参考图时退回单图的「肤色行 vs 西装行」判定。
  if (o.suit) {
    if (o.referencePath && fs.existsSync(o.referencePath)) {
      results.push({
        name: 'assertSuitKeepsFacePixels',
        ...A.assertSuitKeepsFacePixels(o.referencePath, file),
      });
    } else {
      results.push({ name: 'assertSuitDoesNotCoverFace', ...A.assertSuitDoesNotCoverFace(file) });
    }
  }

  const fail = results.filter((r) => !r.ok);
  return {
    pass: fail.length === 0,
    passCount: results.length - fail.length,
    failCount: fail.length,
    results: results.map((r) => ({
      name: r.name, ok: r.ok, actual: r.actual, expected: r.expected, detail: r.detail,
      method: r.method || null, estimated: r.estimated === true, estimatedNote: r.estimatedNote || null,
    })),
    failed: fail.map((f) => ({ name: f.name, detail: f.detail })),
  };
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const assets = resolveAssets();
  console.log('=========================================================');
  console.log(' 真实素材 × 关键工具 全链路业务验收');
  console.log('=========================================================');
  console.log(`工具: ${TOOLS.join(', ')}`);
  console.log(`素材: ${assets.length} 张（${assets.map((a) => a.file).join(', ')}）`);
  console.log(`断言口径: 规格 ${SPEC_ID} @${DPI}dpi；期望底色 ${BG || '按工具默认'}`);
  console.log(`成品落盘: ${path.relative(ROOT, OUT_DIR)}`);
  // 合成图守卫：输入若来自 素材/测试图/ → 明确打印「合成图（仅用于边界用例）」
  for (const a of assets) {
    const notice = syntheticNoticeFor(a.absPath);
    if (notice) console.log(`⚠ ${notice}：${a.file}`);
  }
  console.log('');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  let miniProgram = null;
  let retries = 0;

  if (!NO_IDE) {
    console.log('▶ 连接 IDE 自动化通道…');
    try {
      const conn = await connectWithRecovery();
      miniProgram = conn.miniProgram;
      retries = conn.retries;
      const detected = detectIdeAutoPort();
      console.log(`  ✅ 已连接（重试 ${retries} 次${detected ? '，IDE 自动化端口 ' + detected : ''}）`);
      // 等页面栈就绪（connect 成功 ≠ webview 已就绪；过早调用 currentPage 会报 rawPath 解构错）
      const ready = await waitForAppReady(miniProgram);
      if (!ready.ok) {
        throw new Error(`小程序页面栈未就绪（重试 ${ready.attempts} 次）：${ready.lastErr || '(空页面栈)'}`);
      }
      console.log(`  ✅ 页面栈就绪（${ready.path}，等待 ${ready.attempts} 次）`);
    } catch (e) {
      console.error('\n❌ IDE 自动化通道不可用：' + (e && e.message ? e.message : e));
      console.error('   注意：这是**环境问题**，不是本次验收的业务失败。');
      console.error('   排查顺序：');
      // ① 最常见：dist/ 缺失（编译产物被清）→ IDE 没有可加载的包 → 页面栈永远起不来
      if (!fs.existsSync(path.join(APP, 'dist', 'app.json'))) {
        console.error('     1) ⚠ dist/ 缺失或残缺（最常见原因）→ 先编译：');
        console.error(`        cd idphoto-miniprogram && npm run build:weapp`);
      } else {
        console.error('     1) dist/ 存在 → 确认开发者工具已打开本项目窗口且已重新编译加载');
      }
      console.error(`     2) 手动开自动化通道（问题台账 #86/#87）：`);
      console.error(`        "${IDE_CLI}" auto --project "${APP}" --auto-port ${PORT} --port 16780`);
      console.error('     3) 确认开发者工具「设置 → 安全设置 → 服务端口」已开启（默认 16780）');
      console.error('     4) 确认开发者工具未处于编译/预览忙碌状态（忙碌时页面栈起不来）');
      fs.writeFileSync(path.join(OUT_DIR, 'results.json'),
        JSON.stringify({ error: 'ide-unavailable', message: String(e && e.message || e), results: [] }, null, 2));
      process.exit(3);
    }
  }

  const logs = [];
  if (miniProgram) {
    miniProgram.on('console', (msg) => {
      const parts = (msg.args || []).map((a) => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (e) { return String(a); }
      });
      logs.push(`[${msg.type}] ${parts.join(' ') || msg.text || ''}`);
    });
  }

  try {
    for (const tool of TOOLS) {
      const cardIndex = TOOL_CARDS[tool];
      if (cardIndex === undefined) {
        console.error(`⚠ 未知工具: ${tool}（支持 t1,t2,t3）`);
        continue;
      }
      console.log(`\n──────── ${tool.toUpperCase()} ────────`);

      let page = null;
      if (miniProgram) {
        page = await gotoHome(miniProgram);
        const cards = await page.$$('.tool-card');
        if (cards.length < 3) {
          console.error(`  ❌ 首页卡片数异常（${cards.length}），跳过 ${tool}`);
          for (const a of assets) {
            results.push({ asset: a.file, tool, connectivity: false, error: '首页卡片渲染异常', assertions: null });
          }
          continue;
        }
        await cards[cardIndex].tap();
        await sleep(3000);
        page = await miniProgram.currentPage();
        // 授权全勾（一次即可，后续换图不掉授权）
        const consentItems = await page.$$('.consent__item');
        for (const it of consentItems) { try { await it.tap(); } catch (e) { /* ignore */ } }
        await sleep(300);
        console.log(`  授权项 ${consentItems.length} 已全部勾选`);
      }

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const rec = {
          asset: asset.file,
          assetPurpose: asset.purpose,
          assetSize: asset.size,
          tool,
          connectivity: false,
          status: '',
          product: null,
          assertions: null,
          audit: null,
          error: null,
        };
        const dir = path.join(OUT_DIR, safeName(asset.file), tool);
        fs.mkdirSync(dir, { recursive: true });

        try {
          if (!miniProgram) {
            // --no-ide 模式：对已有成品重新断言
            const existing = path.join(dir, 'result.jpg');
            if (!fs.existsSync(existing)) {
              rec.error = '无既有成品（--no-ide 模式需要先跑过）';
              results.push(rec);
              continue;
            }
            rec.product = existing;
            rec.connectivity = true;
            rec.assertions = runBusinessAssertions(existing, {
              specId: SPEC_ID, dpi: DPI, bgHex: BG || TOOL_BG[tool],
              advisory: DPI >= 600,
              sizeMode: TOOL_SPEC_MODE[tool], srcSize: asset.size,
              suit: tool === 't3',
              referencePath: referenceFor(tool, asset),
            });
            rec.status = '（复用既有成品）';
            // --no-ide 模式读不到页面「智能裁切」信息 → 无法判断人脸检测是否可用。
            //   既有成品都是在模拟器产出的 → 一律按「环境受限」处理头占比断言，
            //   避免把环境限制误报成产品缺陷（与 IDE 模式口径一致）。
            if (rec.assertions) {
              const hr = rec.assertions.results.find((r) => r.name === 'assertHeadRatio');
              if (hr && !hr.ok) {
                hr.envLimited = true;
                hr.envLimitedReason = '既有成品产自开发者工具模拟器（不支持人脸检测）→ 裁切降级为居中裁剪 → 头占比断言不适用；此项为环境限制，非产品缺陷（真机可验）';
                rec.assertions.envLimitedCount = (rec.assertions.envLimitedCount || 0) + 1;
                rec.assertions.failed = rec.assertions.failed.filter((f) => f.name !== 'assertHeadRatio');
                rec.assertions.failCount = rec.assertions.failed.length;
                rec.assertions.pass = rec.assertions.failCount === 0;
                rec.assertions.passCount = rec.assertions.results.length - rec.assertions.failCount;
              }
            }
          } else {
            // ① 注入原图
            await injectImage(miniProgram, asset.absPath, i);
            // ② 点主按钮
            const btn = await page.$('.btn-primary');
            if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
            const logCursor = logs.length;
            await btn.tap();
            // ③ 等状态行
            const st = await waitForStatus(page, TOOL_STATUS[tool], 120);
            rec.status = (st.status || st.pageText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const finished = st.hit;
            rec.audit = parseAuditObjects(logs.slice(logCursor));

            // ④ 抓成品落盘
            const product = await grabProduct(miniProgram, page);
            if (!product) throw new Error('未抓到成品预览图');
            const resultPath = path.join(dir, 'result.jpg');
            fs.writeFileSync(resultPath, Buffer.from(product.base64, 'base64'));
            // 原图副本
            fs.copyFileSync(asset.absPath, path.join(dir, 'original' + path.extname(asset.file).toLowerCase()));
            // 页面截图
            try {
              await miniProgram.screenshot({ path: path.join(dir, 'page.png') });
            } catch (e) { /* 截图失败不阻断 */ }

            rec.product = path.relative(ROOT, resultPath);
            // 连通性 = 状态命中 + 成品落盘成功
            rec.connectivity = finished && rec.status.includes('完成') || (tool === 't3' && rec.status.includes('未换装'));
            if (tool === 't3' && rec.status.includes('未换装')) {
              // T3 明确拒绝非目标构图 —— 这是**正确的业务行为**，连通性算通过
              rec.connectivity = true;
              rec.note = 'T3 明确拒绝（未换装）——符合 R1 契约「非目标构图明确拒绝、不静默出图」';
            }
            if (!rec.connectivity) {
              rec.error = `状态行未命中「完成」：${rec.status || '(空)'}`;
            }

            // ④b 读「智能裁切」信息 → 判断人脸检测是否可用
            //   开发者工具模拟器不支持人脸检测（faceService.ts 明确跳过 devtools），
            //   此时裁切降级为「按画面居中裁剪」→ 头占比**必然**不落规格区间。
            //   这是**环境限制**，不是产品缺陷 → 断言结果要单独标注，不能混进「产品失败」。
            const cropInfo = await readCropInfo(page);
            rec.cropInfo = cropInfo.text;
            rec.faceDetectAvailable = cropInfo.faceDetected;

            // ⑤ 业务断言
            rec.assertions = runBusinessAssertions(resultPath, {
              specId: SPEC_ID, dpi: DPI, bgHex: BG || TOOL_BG[tool],
              advisory: DPI >= 600,
              sizeMode: TOOL_SPEC_MODE[tool], srcSize: asset.size,
              suit: tool === 't3',
              referencePath: referenceFor(tool, asset),
            });
            // 环境受限标注：头占比断言在「人脸检测不可用」时不代表产品缺陷
            if (!cropInfo.faceDetected && rec.assertions) {
              const hr = rec.assertions.results.find((r) => r.name === 'assertHeadRatio');
              if (hr && !hr.ok) {
                hr.envLimited = true;
                hr.envLimitedReason = '开发者工具模拟器不支持人脸检测（services/faceService.ts 跳过 devtools 平台）'
                  + ' → 裁切降级为「按画面居中裁剪」→ 头占比必然不落规格区间；此项为环境限制，非产品缺陷（真机可验）';
                rec.assertions.envLimitedCount = (rec.assertions.envLimitedCount || 0) + 1;
                rec.assertions.failed = rec.assertions.failed.filter((f) => f.name !== 'assertHeadRatio');
                rec.assertions.failCount = rec.assertions.failed.length;
                rec.assertions.pass = rec.assertions.failCount === 0;
                rec.assertions.passCount = rec.assertions.results.length - rec.assertions.failCount;
              }
            }
            // 「不选规格」路径（T2 保持原图尺寸）：成品本就没按规格裁切，
            //   头占比不与规格区间绑定 → 该断言**不适用**，标注为不适用而非失败。
            if (TOOL_SPEC_MODE[tool] === 'keep-original' && rec.assertions) {
              const hr = rec.assertions.results.find((r) => r.name === 'assertHeadRatio');
              if (hr) {
                hr.notApplicable = true;
                hr.notApplicableReason = '该工具未选规格（保持原图尺寸），成品不按规格裁切 → 头占比不与规格区间绑定，此断言不适用';
                rec.assertions.notApplicableCount = (rec.assertions.notApplicableCount || 0) + 1;
                rec.assertions.failed = rec.assertions.failed.filter((f) => f.name !== 'assertHeadRatio');
                rec.assertions.failCount = rec.assertions.failed.length;
                rec.assertions.pass = rec.assertions.failCount === 0;
                rec.assertions.passCount = rec.assertions.results.length - rec.assertions.failCount;
              }
            }
          }

          // ⑥ 落盘断言结果
          fs.writeFileSync(path.join(dir, 'assertions.json'),
            JSON.stringify(rec, null, 2));

          const connTag = rec.connectivity ? '连通✓' : '连通✗';
          const bizTag = rec.assertions ? (rec.assertions.pass ? '业务✓' : `业务✗(${rec.assertions.failCount})`) : '业务—';
          console.log(`  [${i + 1}/${assets.length}] ${asset.file.padEnd(42)} ${connTag} ${bizTag}`);
          if (rec.assertions && !rec.assertions.pass) {
            for (const f of rec.assertions.failed) {
              console.log(`        ✗ ${f.name}: ${f.detail.slice(0, 150)}`);
            }
          }
        } catch (e) {
          rec.error = String((e && e.message) || e);
          console.log(`  [${i + 1}/${assets.length}] ${asset.file.padEnd(42)} 异常: ${rec.error.slice(0, 110)}`);
          try {
            fs.writeFileSync(path.join(dir, 'assertions.json'), JSON.stringify(rec, null, 2));
          } catch (e2) { /* ignore */ }
        }
        results.push(rec);
      }
    }
  } catch (e) {
    console.error('\n❌ 批量验收异常终止：' + (e && e.message ? e.message : e));
    try { if (miniProgram) await miniProgram.close(); } catch (e2) { /* ignore */ }
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ results }, null, 2));
    process.exit(3);
  }

  // ---------------------------------------------------------------- 汇总
  const total = results.length;
  const connPass = results.filter((r) => r.connectivity).length;
  const withAssert = results.filter((r) => r.assertions);
  const bizPass = withAssert.filter((r) => r.assertions.pass).length;
  const bizFail = withAssert.filter((r) => !r.assertions.pass).length;
  const noAssert = results.filter((r) => !r.assertions).length;
  // 环境受限的断言数（人脸检测不可用导致的头占比偏差）—— 与真实业务失败分开统计
  const envLimited = results.reduce((n, r) => n + ((r.assertions && r.assertions.envLimitedCount) || 0), 0);
  const notApplicable = results.reduce((n, r) => n + ((r.assertions && r.assertions.notApplicableCount) || 0), 0);
  const faceDetectUnavailable = results.filter((r) => r.faceDetectAvailable === false).length;

  const summary = {
    generatedAt: new Date().toISOString(),
    ideRetries: retries,
    total,
    connectivity: { pass: connPass, fail: total - connPass },
    business: {
      evaluated: withAssert.length,
      pass: bizPass,
      fail: bizFail,
      notEvaluated: noAssert,
      envLimited,
      notApplicable,
      faceDetectUnavailable,
    },
    note: '连通性通过数与业务断言通过数是两个独立指标，不合并为单一「通过」；'
      + 'envLimited = 环境限制导致的断言偏差（人脸检测不可用），已从业务失败中剔除；'
      + 'notApplicable = 该路径下断言本身不适用（如未选规格时的头占比）',
  };

  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ summary, results }, null, 2));

  console.log('\n=========================================================');
  console.log(' 汇总');
  console.log('=========================================================');
  console.log(`总组合数        : ${total}`);
  console.log(`连通性通过      : ${connPass} / ${total}   （链路跑完且拿到成品）`);
  console.log(`业务断言通过    : ${bizPass} / ${withAssert.length}   （业务产出可判定且全绿）`);
  console.log(`业务断言失败    : ${bizFail}   （真实产品问题，需修复）`);
  console.log(`环境受限断言    : ${envLimited}   （人脸检测不可用导致，已从失败中剔除）`);
  console.log(`断言不适用      : ${notApplicable}   （该路径下断言不适用，如未选规格时的头占比）`);
  console.log(`未做业务断言    : ${noAssert}   （链路未通，无成品可断言）`);
  console.log(`IDE 连接重试    : ${retries} 次`);
  if (faceDetectUnavailable) {
    console.log('');
    console.log(`⚠ 其中 ${faceDetectUnavailable} 个组合运行在「人脸检测不可用」环境`);
    console.log('  （开发者工具模拟器不支持人脸检测 → 裁切降级为居中裁剪 → 头占比断言不适用）。');
    console.log('  这是**环境限制**，不是产品缺陷；头占比须在真机复验。');
  }
  console.log('');
  console.log('※ 连通性与业务断言是两个独立指标：连通性通过不代表业务正确。');

  if (bizFail) {
    console.log('\n业务断言失败明细：');
    for (const r of results) {
      if (!r.assertions || r.assertions.pass) continue;
      console.log(`  · ${r.asset} [${r.tool}]`);
      for (const f of r.assertions.failed) {
        console.log(`      ${f.name}: ${f.detail.slice(0, 170)}`);
      }
    }
  }
  const suitFails = results.filter((r) => r.assertions
    && r.assertions.results.some((x) => x.name === 'assertSuitKeepsFacePixels' && !x.ok));
  if (suitFails.length) {
    console.log('\n⚠ 换装盖脸（AC6/D2 违规）明细：');
    for (const r of suitFails) {
      const hit = r.assertions.results.find((x) => x.name === 'assertSuitKeepsFacePixels');
      const geo = (r.audit || []).find((a) => a.stage === 'suit_geometry');
      const fit = (r.audit || []).find((a) => a.stage === 'suit_fit_v2');
      console.log(`  · ${r.asset} [${r.tool}] ${hit ? hit.detail.slice(0, 110) : ''}`);
      if (geo && fit) {
        console.log(`      几何: 头高来源=${geo.source} headH=${geo.headH} chinY=${geo.chinY} → garmentTop=${fit.garmentTop}`
          + `｜人脸框=alphaBBox(h=${geo.bbox ? geo.bbox.h : '?'})`);
      }
    }
    console.log('  根因分析（据 audit）：');
    console.log('    · suit_geometry.source=estimate → 本次运行**无关键点**，头高由 core/face.js 的');
    console.log('      headMetricsFromBBox 估算（头长 = 人像框高 × HEAD_BBOX_RATIO 0.30）；');
    console.log('    · 该系数假定人像框远高于头（半身/全身构图）；证件照构图下人像框≈头+肩，');
    console.log('      0.30×框高 明显**小于**真实头长 → chinY 估高 → 西装领口上移压到鼻/嘴。');
    console.log('    · 开发者工具模拟器不支持人脸检测（services/faceService.ts 跳过 devtools 平台）');
    console.log('      → 本次全部走 estimate 路径；真机有关键点时走 landmarks 路径，');
    console.log('      但**真机上人脸检测失败时同样落到 estimate 路径** → 同一缺陷仍可能复现。');
  }

  const envItems = results.filter((r) => r.assertions && r.assertions.envLimitedCount);
  if (envItems.length) {
    console.log('\n环境受限明细（不计为产品失败）：');
    for (const r of envItems) {
      const hr = r.assertions.results.find((x) => x.name === 'assertHeadRatio');
      console.log(`  · ${r.asset} [${r.tool}] assertHeadRatio: ${hr && hr.envLimitedReason ? hr.envLimitedReason.slice(0, 130) : ''}`);
    }
  }
  console.log('\n结果已写入 ' + path.relative(ROOT, path.join(OUT_DIR, 'results.json')));

  if (miniProgram) {
    try { await miniProgram.close(); } catch (e) { /* ignore */ }
  }
  // 退出码如实反映两个维度：
  //   连通性失败 → 1；业务断言失败（连通性 OK）→ 4；两者都过 → 0
  const connFail = total - connPass;
  if (connFail > 0) process.exit(1);
  else if (bizFail > 0) process.exit(4);
  else process.exit(0);
})();
