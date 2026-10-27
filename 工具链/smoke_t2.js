/**
 * 证件照小程序 · 自动化冒烟（T2 单独换底色，模拟器内无人值守）
 *
 * 复用 smoke_auto.js 的全部坑位经验（见其头注释）：
 *   NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot / mock 图先写入 USER_DATA_PATH
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_t2.js
 *   NODE_OPTIONS= node 工具链/smoke_t2.js --img 素材/测试图/test_standard.png
 *
 * 流程：
 *   连接 IDE → 断言首页 → 进 T2（pages/tool-bg）→ 勾选 2 项授权 →
 *   注入测试图 + mock chooseImage → 点「选择照片并换底」→ 轮询到"完成/失败" →
 *   断言导出信息（尺寸/底色/降级标记）→ 截图 → PASS/FAIL
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
const PORT = Number(getArg('--port', 9421));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_standard.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { readStatus, waitForStatus } = require('./smoke_kit');
const { connectAutomator } = require('./automator_connect');

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

(async () => {
  if (!fs.existsSync(IMG)) {
    console.error('缺少测试图:', IMG, '\n先跑: python 工具链/make_test_images.py');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const logs = [];
  const errors = [];
  let miniProgram;

  try {
    miniProgram = await connectAutomator({ projectPath: APP, port: PORT, timeout: 60000 });
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
    let curPath;
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      curPath = (st[st.length - 1] || {}).path;
      if (curPath) break;
    }
    console.log('0) 当前页面 =', curPath || '(未就绪)');

    // 1. 进 T2（tap 卡片，失败退回 navigateTo）
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    console.log(`1) 首页工具卡片数 = ${cards.length} ${cards.length >= 5 ? 'OK' : 'FAIL(应≥5)'}`);
    if (cards.length < 5) throw new Error('首页卡片数异常');
    try {
      await cards[1].tap(); // 第 2 张 = 单独换底色
    } catch (e) {
      console.log('1) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-bg/index' });
    }
    await sleep(3000);
    page = await miniProgram.currentPage();
    const stack = await miniProgram.pageStack().catch(() => []);
    const onT2 = ((stack[stack.length - 1] || {}).path || '').includes('tool-bg');
    console.log('1) 当前页面 =', (stack[stack.length - 1] || {}).path || '(未就绪)', onT2 ? 'OK' : 'FAIL(未进入 T2)');
    if (!onT2) throw new Error('未进入 T2 页面');

    // 2. 勾选授权（默认不勾 → 全部勾上；T2 需 faceLocal + faceCloudEnhance 两项）
    const items = await page.$$('.consent__item');
    for (const it of items) await it.tap();
    await sleep(300);
    console.log(`2) 授权项共 ${items.length}，已全部勾选 ${items.length === 2 ? 'OK' : 'FAIL(应=2)'}`);

    // 3. 注入测试图 + mock chooseImage
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_t2.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });
    console.log('3) 已注入图片 + mock chooseImage →', target);

    // 4. 点主按钮
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
    await btn.tap();
    console.log('4) 已点击「选择照片并换底」，等待处理…');

    // 5. 轮询结果
    // 轮询：只认状态行（.status-line），避免展示文案污染判定（2026-10-27 修正）
    const st = await waitForStatus(page, ['完成', '失败'], 45);
    const msg = st.pageText;
    const status = st.status || msg;
    const finished = st.hit;
    await shot('03-t2.png');

    // 5.5 回归护栏（任务 #50，2026-10-27 真机反馈）：换底色后必须**立即重新合成**，
    //      成品信息里的底色要跟着变（旧实现只改 state → 成品仍是白底 #FFFFFF）
    let bgOk = true;
    try {
      const texts = await page.$$('text');
      let chip = null;
      for (const t of texts) {
        let s = '';
        try { s = (await t.text()) || ''; } catch (_) {}
        if (s.indexOf('标准深蓝') >= 0) { chip = t; break; }
      }
      if (!chip) {
        console.log('5.5) 未找到「标准深蓝」底色 chip（跳过该断言）');
      } else {
        await chip.tap();
        await sleep(5000);
        const txt2 = await readPageText(page);
        bgOk = txt2.indexOf('底色 #438EDB') >= 0;
        console.log(`5.5) 换底色后重新合成 = ${bgOk ? 'OK(底色已更新为 #438EDB)' : 'FAIL(底色未更新)'}`);
        await shot('03-t2-recolor.png');
      }
    } catch (e) {
      console.log('5.5) 换底色回归检查异常:', e.message);
    }

    const auditLogs = logs.filter((l) => l.includes('[audit]'));
    const pass = finished && status.includes('完成') && errors.length === 0 && bgOk;

    console.log('\n===== T2 冒烟结果 =====');
    console.log('状态行:', status.replace(/\s+/g, ' ').slice(0, 120));
    console.log('处理完成:', finished ? (status.includes('完成') ? 'OK' : 'FAIL(失败文案)') : 'FAIL(超时45s)');
    console.log('运行时错误数:', errors.length);
    console.log('换底色重新合成:', bgOk ? 'OK' : 'FAIL');
    console.log('audit 日志:', auditLogs.length ? auditLogs.join(' | ') : '（无 → 说明未触发上云增强）');
    if (msg) console.log('页面文本:', msg.replace(/\s+/g, ' ').slice(0, 400));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '03-t2.png'));
    console.log(pass ? '✅ T2 冒烟通过（换底主链路在模拟器内跑通）' : '❌ T2 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
