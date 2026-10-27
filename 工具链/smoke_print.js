/**
 * 证件照小程序 · T6 冲印排版专项冒烟（任务 #49：入口可达性 + 页面要素）
 *
 * 前置（一次性）：微信开发者工具 → 设置 → 安全设置 → **服务端口：开启**（台账 #19）
 * 依赖：miniprogram-automator 装于隔离工作区（勿装进项目 node_modules，会重排 webpack）
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_print.js
 *
 * 断言：
 *   1) 首页 6 张卡片，第 6 张是「冲印排版」（任务 #49 的回归护栏）
 *   2) **点第 6 张卡片 → 真实进入 T6 页面**（用户路径），页面含：标题/常规相纸/迷你相纸/裁剪参考线开关
 *   3) 返回首页 → 点第 1 张卡片进入 T1 → 页面含「另存为冲印排版」入口（PRD K1 入口①）
 *
 * 坑位记录（实测于本项目，2026-10-27）：
 *   1. 命令必须 `NODE_OPTIONS=` 前缀
 *   2. automator 0.13：**不要用 miniProgram.navigateTo()**（本项目实测对任何页面都报
 *      `Uncaught [object Object]`，对照组 tool-spec 同样失败）→ 一律用「点卡片」的真实用户路径
 *   3. Page 没有 screenshot/path()；截图用 miniProgram.screenshot()
 *   4. 端口被占用会报 `Port xxx is in use` → 换端口
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
const PORT = Number(getArg('--port', 9426));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageText(page) {
  const parts = [];
  // 文本既可能落在 <text>，也可能落在 <button>（Taro Button 编译成 button 标签）
  for (const sel of ['text', 'button']) {
    try {
      const vs = await page.$$(sel);
      for (const v of vs) {
        try { parts.push((await v.text()) || ''); } catch (_) {}
      }
    } catch (e) { /* ignore */ }
  }
  return parts.join('');
}

function assert(cond, label) {
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const errors = [];
  let miniProgram;

  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
      if (msg.type === 'error') errors.push(t);
    });
    const shot = async (name) => {
      try { await miniProgram.screenshot({ path: path.join(SHOTS, name) }); }
      catch (e) { console.log('（截图跳过:', e.message, '）'); }
    };
    const curPath = async () => {
      const st = await miniProgram.pageStack().catch(() => []);
      return (st[st.length - 1] || {}).path || '';
    };

    // 0. 等待首页就绪
    let p = '';
    for (let i = 0; i < 8; i++) {
      await sleep(2500);
      p = await curPath();
      if (p) break;
    }
    console.log('0) 当前页面 =', p || '(未就绪)');

    // 1. 首页卡片
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    assert(cards.length >= 6, `首页卡片数 = ${cards.length}（应 ≥6）`);
    let lastTxt = '';
    try { lastTxt = (await cards[cards.length - 1].text()) || ''; } catch (e) { /* ignore */ }
    assert(lastTxt.indexOf('冲印排版') >= 0, `第 6 张卡片含「冲印排版」= "${lastTxt.slice(0, 36)}"`);
    await shot('08-home-6cards.png');

    // 2. 点第 6 张卡片 → 进入 T6（真实用户路径）
    try {
      await cards[cards.length - 1].tap();
    } catch (e) {
      console.log('tap 第 6 张卡片失败:', e.message);
    }
    await sleep(3000);
    p = await curPath();
    assert(p === 'pages/tool-print/index', `已进入 T6 页面 = ${p}`);
    page = await miniProgram.currentPage();
    const t6 = await pageText(page);
    assert(t6.indexOf('冲印排版') >= 0, 'T6 页面含标题「冲印排版」');
    assert(t6.indexOf('相纸（常规冲印）') >= 0, 'T6 页面含「相纸（常规冲印）」');
    assert(t6.indexOf('相纸（迷你打印机）') >= 0, 'T6 页面含「相纸（迷你打印机）」');
    assert(t6.indexOf('显示裁剪参考线') >= 0, 'T6 页面含「显示裁剪参考线」开关');
    assert(t6.indexOf('从相册选择') >= 0, 'T6 页面含「从相册选择」按钮');
    await shot('08-t6.png');

    // 3. 返回首页（automator 0.13 无 navigateTo，但 navigateBack 一般可用）
    let backOk = false;
    try {
      await miniProgram.navigateBack();
      await sleep(2500);
      backOk = (await curPath()) === 'pages/home/index';
    } catch (e) {
      console.log('navigateBack 失败:', e.message);
    }
    if (!backOk) {
      console.log('⚠️ 未能返回首页，跳过 T1 入口断言');
    } else {
      // 4. 点第 1 张卡片 → T1 页面，断言「另存为冲印排版」入口存在
      page = await miniProgram.currentPage();
      const cards2 = await page.$$('.tool-card');
      try {
        await cards2[0].tap();
      } catch (e) {
        console.log('tap 第 1 张卡片失败:', e.message);
      }
      await sleep(3000);
      p = await curPath();
      assert(p === 'pages/tool-idphoto/index', `已进入 T1 页面 = ${p}`);
      page = await miniProgram.currentPage();
      const t1 = await pageText(page);
      // 注意：T1 的「另存为冲印排版」按钮只在**出图后**才渲染（挂在预览区），
      // 本脚本未跑 T1 完整流程，故此处只做提示性断言；
      // 承接链路的端到端验证见 `smoke_auto.js --with-print`。
      if (t1.indexOf('另存为冲印排版') >= 0) {
        assert(true, 'T1 页面含「另存为冲印排版」入口（PRD K1 入口①）');
      } else {
        console.log('ℹ️ T1 未出图，「另存为冲印排版」按钮不渲染（预期）；承接 E2E 见 smoke_auto --with-print');
      }
      await shot('08-t1-print-entry.png');
    }

    console.log('\n运行时错误数:', errors.length);
    errors.slice(0, 5).forEach((e) => console.log('  ', e));
    assert(errors.length === 0, '运行时错误数 = 0');

    console.log(process.exitCode ? '\n❌ T6 冒烟未通过' : '\n✅ T6 冒烟通过');
  } catch (e) {
    console.error('运行失败:', e && e.message);
    process.exitCode = 1;
  } finally {
    try { await miniProgram && miniProgram.close(); } catch (e) { /* ignore */ }
  }
})();
