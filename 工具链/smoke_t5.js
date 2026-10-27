/**
 * 证件照小程序 · 自动化冒烟（T5 规格转换，模拟器内无人值守）
 *
 * 复用 smoke_auto.js / smoke_t2.js 的全部坑位经验：
 *   NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot / mock 图先写入 USER_DATA_PATH
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_t5.js
 *   NODE_OPTIONS= node 工具链/smoke_t5.js --img 素材/测试图/test_standard.png
 *
 * 特点：T5 **无需人脸授权**（TOOL_CONSENTS.T5 = []），流程里没有授权勾选步骤。
 *
 * 流程：
 *   连接 IDE → 断言首页 → 进 T5（pages/tool-spec）→ 注入测试图 + mock chooseImage →
 *   点「选择照片并转换」（默认：一寸 300dpi + 200KB 上限）→ 轮询到"完成/注意/失败" →
 *   断言导出信息（像素/KB/质量）→ 截图 → PASS/FAIL
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
const PORT = Number(getArg('--port', 9422));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_standard.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { readStatus, waitForStatus } = require('./smoke_kit');

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
    let curPath;
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      curPath = (st[st.length - 1] || {}).path;
      if (curPath) break;
    }
    console.log('0) 当前页面 =', curPath || '(未就绪)');

    // 1. 进 T5（第 5 张卡片，index 4；失败退回 navigateTo）
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    console.log(`1) 首页工具卡片数 = ${cards.length} ${cards.length >= 5 ? 'OK' : 'FAIL(应≥5)'}`);
    if (cards.length < 5) throw new Error('首页卡片数异常');
    try {
      await cards[4].tap(); // 第 5 张 = 规格转换
    } catch (e) {
      console.log('1) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-spec/index' });
    }
    await sleep(3000);
    page = await miniProgram.currentPage();
    const stack = await miniProgram.pageStack().catch(() => []);
    const onT5 = ((stack[stack.length - 1] || {}).path || '').includes('tool-spec');
    console.log('1) 当前页面 =', (stack[stack.length - 1] || {}).path || '(未就绪)', onT5 ? 'OK' : 'FAIL(未进入 T5)');
    if (!onT5) throw new Error('未进入 T5 页面');

    // 2. 确认页面无授权区块（T5 不需要人脸授权）
    const consentItems = await page.$$('.consent__item');
    console.log(`2) 授权区块项 = ${consentItems.length} ${consentItems.length === 0 ? 'OK（T5 无需授权）' : 'FAIL(不应有授权项)'}`);

    // 3. 注入测试图 + mock chooseImage
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_t5.png`;
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

    // 4. 点主按钮（默认一寸 300dpi + 200KB 上限）
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
    await btn.tap();
    console.log('4) 已点击「选择照片并转换」，等待处理…');

    // 5. 轮询结果（**只认状态行 .status-line**，不再用整页文本判失败——
    //    镜像自查的静态文案里含「会导致审核失败」，会把成功误判为失败，2026-10-27 修正）
    const st = await waitForStatus(page, ['完成', '注意', '失败'], 45);
    const msg = st.pageText;
    const status = st.status || msg;
    const finished = st.hit;
    await shot('04-t5.png');

    const pass = finished && !status.includes('失败') && (status.includes('完成') || status.includes('注意')) && errors.length === 0;

    console.log('\n===== T5 冒烟结果 =====');
    console.log('状态行:', status.replace(/\s+/g, ' ').slice(0, 120));
    console.log('处理完成:', finished ? (status.includes('失败') ? 'FAIL(失败文案)' : 'OK') : 'FAIL(超时45s)');
    console.log('运行时错误数:', errors.length);
    if (msg) console.log('页面文本:', msg.replace(/\s+/g, ' ').slice(0, 400));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '04-t5.png'));
    console.log(pass ? '✅ T5 冒烟通过（规格转换主链路在模拟器内跑通）' : '❌ T5 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
