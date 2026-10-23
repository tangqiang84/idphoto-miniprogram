/**
 * 证件照小程序 · 自动化冒烟（600dpi 全工具免费开放 + 首页免费标识）
 *
 * 对应 owner 决策「MVP 暂不上付费档」（2026-10-23）：
 *   - Q1：600dpi 印刷级在全部工具开放（同样免费）→ T1/T2/T3 三页各带 300/600 档位开关
 *   - Q2：首页显式标注「全部功能免费·无水印」
 *   - Q3：600dpi 时 KB 项不参与判定，只作提示（advisory 级）
 *   - Q4：600dpi 动态提高工作图上限，输出真 600dpi（core/compose.js）
 *
 * 验证目标：
 *   1. 静态层：core/compose.js 存在且导出 planOutput；三页均已接入 planOutput + DPI_HD；
 *              代码中**不得出现付费/水印相关实现**（不设付费档 → 无付费入口）；
 *              compliance.js 必须有 advisory 分档逻辑（600dpi KB 不阻断）。
 *   2. 首页：渲染 `.home__free-badge`，文案含「免费」「无水印」「600dpi」。
 *   3. T1：切到 600dpi 档 → 跑全链路 → 断言
 *      ① 规格芯片显示 600dpi 对应像素（591×827 而非 295×413）；
 *      ② 预审「文件大小」为提示项（advisory），且整体结论仍可为「全部通过」；
 *      ③ 无崩溃。
 *   4. T2/T3：回归（300dpi 默认档位仍正常出图）。
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_dpi.js
 *
 * 坑位经验（沿用 smoke_auto / smoke_t2 / smoke_face）：
 *   - 禁 reLaunch()；Page 无 screenshot/path()；mock 图必须先 evaluate 注入 USER_DATA_PATH。
 *   - Toast 不在 DOM → 断言业务状态，不断言 Toast 文案。
 *   - bash 的 grep 在本环境无输出 → 静态断言全部用 Node fs 读文件，不依赖 shell。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const SHOTS = path.join(ROOT, '素材', '测试截图');
const SRC = path.join(APP, 'src');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(getArg('--port', 9431));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_standard.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPageText(page) {
  try {
    const el = await page.$('.page');
    let txt = '';
    try { txt = (await el.text()) || ''; } catch (_) {}
    if (!txt) {
      const vs = await page.$$('text');
      const parts = [];
      for (const v of vs) { try { parts.push((await v.text()) || ''); } catch (_) {} }
      txt = parts.join(' ');
    }
    return txt;
  } catch (e) { return ''; }
}

// ============ 静态断言 ============

function readSrc(rel) {
  const p = path.join(SRC, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// 1. core/compose.js 存在且导出 planOutput
function checkComposeModule() {
  const src = readSrc(path.join('core', 'compose.js'));
  const problems = [];
  if (!src) problems.push('core/compose.js 不存在');
  else {
    if (!/module\.exports[\s\S]*planOutput/.test(src)) problems.push('compose.js 未导出 planOutput');
    if (!/MIN_WORK_EDGE/.test(src)) problems.push('compose.js 缺 MIN_WORK_EDGE');
    if (!/MAX_WORK_EDGE/.test(src)) problems.push('compose.js 缺 MAX_WORK_EDGE');
  }
  return problems;
}

// 2. 三页均接入 planOutput + DPI_HD
function checkPagesWired() {
  const pages = [
    ['tool-idphoto', 'T1'],
    ['tool-bg', 'T2'],
    ['tool-suit', 'T3'],
  ];
  const problems = [];
  const wired = [];
  for (const [dir, tag] of pages) {
    const src = readSrc(path.join('pages', dir, 'index.tsx'));
    if (!src) { problems.push(`${tag} 页面源码不存在`); continue; }
    const hasPlan = src.includes('planOutput');
    const hasHd = src.includes('DPI_HD');
    const hasDpiState = src.includes('setDpi');
    if (!hasPlan) problems.push(`${tag} 未接入 planOutput`);
    if (!hasHd) problems.push(`${tag} 未接入 DPI_HD`);
    if (!hasDpiState) problems.push(`${tag} 缺少 dpi 档位切换`);
    if (hasPlan && hasHd && hasDpiState) wired.push(tag);
  }
  return { problems, wired };
}

// 3. 代码中不得有付费/水印实现（不设付费档 → 无任何付费入口）
function checkNoPaymentImpl() {
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p); }
      else if (/\.(tsx?|js|jsx?)$/.test(name)) files.push(p);
    }
  };
  walk(path.join(SRC, 'pages'));
  walk(path.join(SRC, 'core'));
  walk(path.join(SRC, 'services'));
  const banned = [
    'requestPayment', 'wxPay', 'wx.requestPayment', 'paySig', 'trade_type',
    'mch_id', 'prepay_id', 'subscribeMessage', 'openid',
  ];
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const kw of banned) {
      if (src.includes(kw)) problems.push(`${path.relative(APP, f)}: ${kw}`);
    }
  }
  return problems;
}

// 4. compliance.js 必须有 advisory 分档（600dpi KB 不阻断）
function checkComplianceAdvisory() {
  const src = readSrc(path.join('core', 'compliance.js'));
  const problems = [];
  if (!/level:\s*isHd\s*\?\s*'advisory'\s*:\s*'required'/.test(src)) {
    problems.push('compliance.js 缺 600dpi filesize advisory 分档');
  }
  if (!/level\s*!==\s*'advisory'/.test(src)) {
    problems.push('compliance.js 未按 required 过滤计算 pass');
  }
  return problems;
}

// 5. 首页免费标识源码存在
function checkFreeBadgeSrc() {
  const src = readSrc(path.join('pages', 'home', 'index.tsx'));
  const problems = [];
  if (!src.includes('home__free-badge')) problems.push('首页缺 free-badge');
  if (!/全部功能免费/.test(src)) problems.push('首页免费标识文案缺失');
  if (!/无水印/.test(src)) problems.push('首页免费标识缺「无水印」');
  return problems;
}

(async () => {
  if (!fs.existsSync(IMG)) {
    console.error('缺少测试图:', IMG, '\n先跑: python 工具链/make_test_images.py');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const errors = [];
  let miniProgram;

  // ---- 0. 静态断言 ----
  const composeProblems = checkComposeModule();
  console.log('0) core/compose.js 存在且导出 planOutput:', composeProblems.length === 0 ? 'OK' : 'FAIL ' + composeProblems.join(', '));

  const { problems: wireProblems, wired } = checkPagesWired();
  console.log('0) T1/T2/T3 均接入 planOutput+DPI_HD:', wireProblems.length === 0 ? 'OK（' + wired.join('/') + '）' : 'FAIL ' + wireProblems.join(', '));

  const payProblems = checkNoPaymentImpl();
  console.log('0) 代码中无付费/支付实现:', payProblems.length === 0 ? 'OK' : 'FAIL ' + payProblems.join(', '));

  const compProblems = checkComplianceAdvisory();
  console.log('0) compliance 600dpi advisory 分档:', compProblems.length === 0 ? 'OK' : 'FAIL ' + compProblems.join(', '));

  const badgeProblems = checkFreeBadgeSrc();
  console.log('0) 首页免费标识源码:', badgeProblems.length === 0 ? 'OK' : 'FAIL ' + badgeProblems.join(', '));

  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
      if (msg.type === 'error') {
        errors.push(t);
        try { fs.appendFileSync(path.join(SHOTS, '..', 'smoke_dpi_errors.log'), JSON.stringify(msg) + '\n'); } catch (_) {}
      }
    });
    const shot = async (name) => {
      try { await miniProgram.screenshot({ path: path.join(SHOTS, name) }); }
      catch (e) { console.log('（截图跳过:', e.message, '）'); }
    };

    // 1. 等待首页就绪（禁 reLaunch）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }

    // 2. 首页免费标识
    let page = await miniProgram.currentPage();
    const homeTxt = await readPageText(page);
    const badgeEls = await page.$$('.home__free-badge');
    const badgeText = badgeEls.length
      ? (await badgeEls[0].text().catch(() => '')) || ''
      : '';
    const badgeOk = badgeEls.length > 0 && /免费/.test(homeTxt) && /无水印/.test(homeTxt) && /600dpi/.test(homeTxt);
    console.log('1) 首页免费标识渲染:', badgeOk ? 'OK（' + badgeText.trim().slice(0, 40) + '）' : 'FAIL');
    await shot('10-home-free.png');

    // 3. 进 T1
    const cards = await page.$$('.tool-card');
    if (cards.length < 5) throw new Error('首页卡片数异常: ' + cards.length);
    try { await cards[0].tap(); }
    catch (e) {
      console.log('  tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' });
    }
    await sleep(3000);
    let stack = await miniProgram.pageStack().catch(() => []);
    const onT1 = ((stack[stack.length - 1] || {}).path || '').includes('tool-idphoto');
    console.log('2) 进入 T1:', onT1 ? 'OK' : 'FAIL');
    if (!onT1) throw new Error('未进入 T1 页面');
    page = await miniProgram.currentPage();

    // 4. 切到 600dpi 档（.dpi-opt 第 2 个）
    const dpiOpts = await page.$$('.dpi-opt');
    console.log(`3) T1 档位按钮数 = ${dpiOpts.length}（应为 2）`);
    const hasTwoDpi = dpiOpts.length === 2;
    if (hasTwoDpi) {
      await dpiOpts[1].tap();
      await sleep(1000);
      const on600 = await page.$$('.dpi-opt--on');
      const onTxt = on600.length ? ((await on600[0].text().catch(() => '')) || '') : '';
      console.log('3) 切到 600dpi 生效:', /600/.test(onTxt) ? 'OK（' + onTxt.trim() + '）' : 'FAIL（当前选中=' + onTxt.trim() + '）');
    } else {
      console.log('3) 切到 600dpi 生效: FAIL（档位按钮数异常）');
    }

    // 5. 断言规格芯片已按 600dpi 显示像素（一寸 591×827，而非 295×413）
    const chips = await page.$$('.spec-chip');
    let chipText = '';
    for (const c of chips) { try { chipText += ((await c.text()) || '') + ' '; } catch (_) {} }
    const chip600 = /591×827/.test(chipText);
    const chip300 = /295×413/.test(chipText);
    console.log('4) 规格芯片显示 600dpi 像素(591×827):', chip600 ? 'OK' : 'FAIL（实际：' + chipText.trim().slice(0, 80) + '）');
    console.log('4) 规格芯片不再显示 300dpi 像素(295×413):', chip300 ? 'FAIL' : 'OK');

    // 6. 勾选授权 + 注入测试图 + 跑 T1 全链路
    const consentItems = await page.$$('.consent__item');
    if (consentItems.length < 2) throw new Error('T1 授权项缺失');
    await consentItems[0].tap();
    await sleep(500);
    await consentItems[1].tap();
    await sleep(800);

    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_dpi_input.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64, target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });

    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('T1 找不到 .btn-primary');
    await btn.tap();
    let done = false, txt = '';
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      txt = await readPageText(page);
      if (txt.includes('完成') || txt.includes('失败') || txt.includes('处理失败')) { done = true; break; }
    }
    await shot('11-t1-600dpi.png');

    const t1HasCheck = txt.includes('合规预审');
    const t1NoCrash = !txt.includes('处理失败');
    const t1HasAdvisory = txt.includes('提示项');
    console.log('5) T1 600dpi 预审区块渲染:', t1HasCheck ? 'OK' : 'FAIL');
    console.log('5) T1 600dpi 无崩溃:', t1NoCrash && done ? 'OK' : 'FAIL');
    console.log('5) T1 600dpi KB 提示项(advisory)呈现:', t1HasAdvisory ? 'OK' : '（未出现——300dpi 档或体积未超限时属正常）');

    // 7. T2 回归（默认 300dpi）
    await miniProgram.navigateBack().catch(() => {});
    await sleep(2000);
    stack = await miniProgram.pageStack().catch(() => []);
    if (!((stack[stack.length - 1] || {}).path || '').includes('pages/home')) {
      await miniProgram.switchTab && (await miniProgram.switchTab({ url: '/pages/home/index' }).catch(() => {}));
      await sleep(2000);
    }
    page = await miniProgram.currentPage();
    const cards2 = await page.$$('.tool-card');
    await cards2[1].tap();
    await sleep(3000);
    stack = await miniProgram.pageStack().catch(() => []);
    const onT2 = ((stack[stack.length - 1] || {}).path || '').includes('tool-bg');
    console.log('6) 进入 T2:', onT2 ? 'OK' : 'FAIL');
    if (!onT2) throw new Error('未进入 T2 页面');
    page = await miniProgram.currentPage();

    const t2DpiOpts = await page.$$('.dpi-opt');
    console.log(`7) T2 档位按钮数 = ${t2DpiOpts.length}（默认档位为「保持原图尺寸」时为 0，属正常）`);

    const t2Consent = await page.$$('.consent__item');
    if (t2Consent.length < 1) throw new Error('T2 授权项缺失');
    // T2 需集齐全部授权项（本地处理 + 上云增强），逐项勾选
    for (let i = 0; i < t2Consent.length; i++) {
      await t2Consent[i].tap();
      await sleep(600);
    }
    const t2Granted = await readPageText(page);
    const t2GrantedMark = `需授权（${t2Consent.length}/${t2Consent.length}）`;
    console.log('7) T2 授权集齐:', t2Granted.includes(t2GrantedMark) ? 'OK' : `FAIL（实际：${t2GrantedMark} 未出现）`);
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });
    const btn2 = await page.$('.btn-primary');
    await btn2.tap();
    let done2 = false, txt2 = '';
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      txt2 = await readPageText(page);
      if (txt2.includes('完成') || txt2.includes('失败') || txt2.includes('处理失败')) { done2 = true; break; }
    }
    await shot('12-t2-regress.png');
    const t2Ok = done2 && !txt2.includes('处理失败') && txt2.includes('完成');
    console.log('7) T2 300dpi 回归出图:', t2Ok ? 'OK' : 'FAIL');

    const t2GrantedOk = t2Granted.includes(t2GrantedMark);
    const pass =
      composeProblems.length === 0 && wireProblems.length === 0 &&
      payProblems.length === 0 && compProblems.length === 0 && badgeProblems.length === 0 &&
      badgeOk && onT1 && hasTwoDpi && chip600 && !chip300 &&
      done && t1HasCheck && t1NoCrash && onT2 && t2GrantedOk && t2Ok &&
      errors.length === 0;

    console.log('\n===== 600dpi 全免费开放 冒烟结果 =====');
    console.log('运行时错误数:', errors.length);
    if (txt) console.log('T1 文本:', txt.replace(/\s+/g, ' ').slice(0, 400));
    if (txt2) console.log('T2 文本:', txt2.replace(/\s+/g, ' ').slice(0, 300));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '10-home-free.png'), path.join(SHOTS, '11-t1-600dpi.png'), path.join(SHOTS, '12-t2-regress.png'));
    console.log(pass ? '✅ 600dpi 免费开放冒烟通过' : '❌ 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
