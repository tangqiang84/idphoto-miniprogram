/**
 * 证件照小程序 · 自动化冒烟（隐私政策入口页 #17，模拟器内无人值守）
 *
 * 复用 smoke_auto/t2/t5 的坑位经验：NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot。
 * 特点：纯静态页 + 首页入口跳转，无需 mock 图片、无需授权，是最轻的冒烟。
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_privacy.js
 *
 * 流程：连接 IDE → 断言首页承诺卡片有「隐私政策」入口 → 点击进入 pages/privacy →
 *       断言全文关键承诺文本（端侧/单独同意/境内/90天/联系邮箱/备案号）→ 截图 → PASS/FAIL
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
const PORT = Number(getArg('--port', 9423));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readPageText(page) {
  try {
    const vs = await page.$$('text');
    const parts = [];
    for (const v of vs) { try { parts.push((await v.text()) || ''); } catch (_) {} }
    return parts.join(' ');
  } catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const logs = [];
  const errors = [];
  let miniProgram;

  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
      logs.push(t);
      if (msg.type === 'error') errors.push(t);
    });
    const shot = async (name) => {
      try { await miniProgram.screenshot({ path: path.join(SHOTS, name) }); }
      catch (e) { console.log('（截图跳过:', e.message, '）'); }
    };

    // 0. 等待首页就绪（禁 reLaunch）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }

    // 1. 断言首页承诺卡片有隐私政策入口
    let page = await miniProgram.currentPage();
    const homeTxt = await readPageText(page);
    const hasEntry = homeTxt.includes('隐私政策');
    console.log(`1) 首页承诺卡片含「隐私政策」入口: ${hasEntry ? 'OK' : 'FAIL'}`);
    if (!hasEntry) throw new Error('首页找不到隐私政策入口');

    // 2. 点击入口 → 进入 pages/privacy
    let entered = false;
    try {
      const card = await page.$('.home__privacy');
      await card.tap();
      await sleep(3000);
    } catch (e) {
      console.log('2) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/privacy/index' });
      await sleep(2000);
    }
    const stack = await miniProgram.pageStack().catch(() => []);
    const cur = (stack[stack.length - 1] || {}).path || '';
    entered = cur.includes('privacy');
    console.log(`2) 当前页面 = ${cur || '(未就绪)'} ${entered ? 'OK' : 'FAIL(未进入隐私政策页)'}`);
    if (!entered) throw new Error('未进入隐私政策页');

    // 3. 断言全文关键承诺文本（与 privacy.js 行为对应的核心承诺）
    page = await miniProgram.currentPage();
    const txt = await readPageText(page);
    // 「百度智能云」为 2026-10-23 新增断言：接第三方 API 后必须在政策页点名披露接收方
    // （个保法第 23 条），漏写即视为披露缺失 → 提审风险。
    const keys = ['隐私政策', '单独同意', '本地', '境内', '不用于任何模型训练', '90 天', 'tangqiang@vip.126.com', 'ICP 备案审核中', '撤回同意', '百度智能云'];
    const missing = keys.filter((k) => !txt.includes(k));
    console.log(`3) 关键承诺文本 ${keys.length - missing.length}/${keys.length} ${missing.length === 0 ? 'OK' : 'FAIL 缺失: ' + missing.join('、')}`);
    await shot('05-privacy.png');

    const pass = entered && missing.length === 0 && errors.length === 0;

    console.log('\n===== 隐私政策页冒烟结果 =====');
    console.log('入口可达:', hasEntry ? 'OK' : 'FAIL');
    console.log('页面跳转:', entered ? 'OK' : 'FAIL');
    console.log('运行时错误数:', errors.length);
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '05-privacy.png'));
    console.log(pass ? '✅ 隐私政策页冒烟通过（入口可达 + 全文完整 + 运行时错误 0）' : '❌ 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
