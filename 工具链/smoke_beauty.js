/**
 * 证件照小程序 · 自动化冒烟（受限美颜，任务 #38 / PRD E 章 / AC2）
 *
 * 复用 smoke_auto.js / smoke_mirror.js 的坑位经验（NODE_OPTIONS= 前缀 / 禁 reLaunch /
 * mockWxMethod 注入 chooseImage）。
 *
 * 验证范围（UI 层，模拟器内无人值守）：
 *   1. T1 取图后渲染美颜折叠面板 .beauty（AC2：受限美颜为 T1 内可选折叠项）。
 *   2. 点 .beauty__head 展开 → .beauty__panel 出现。
 *   3. 面板内含 .beauty__forbidden（瘦脸/大眼/重塑五官 灰置禁用文案，AC2 验收：禁用项可见且不可点）。
 *
 * 说明：
 *   - 真实「应用美颜并重新生成」的像素效果与滑块交互依赖真机，列入任务 #14 真机冒烟；
 *     本脚本在模拟器内验证面板渲染与合规禁用项展示不崩溃（结构回归）。
 *   - 需要测试图：默认 素材/测试图/test_standard.png。
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/soke_beauty.js
 *   NODE_OPTIONS= node 工具链/smoke_beauty.js --img 素材/测试图/test_standard.png --port 9420
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
const PORT = Number(getArg('--port', 9420));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_standard.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureHome(miniProgram) {
  let curPath;
  for (let i = 0; i < 6; i++) {
    await sleep(3000);
    const st = await miniProgram.pageStack().catch(() => []);
    curPath = (st[st.length - 1] || {}).path;
    if (curPath) break;
  }
  if (curPath && curPath !== 'pages/home/index') {
    try { await miniProgram.navigateTo({ url: '/pages/home/index' }); await sleep(3000); }
    catch (e) { /* ignore */ }
  }
  return curPath;
}

(async () => {
  if (!fs.existsSync(IMG)) {
    console.error('缺少测试图:', IMG, '\n先跑: python 工具链/make_test_images.py');
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  const errors = [];
  let miniProgram;

  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      if (msg.type === 'error') errors.push(`[${msg.type}] ${msg.text || msg.message || ''}`);
    });

    const cur = await ensureHome(miniProgram);
    console.log('0) 当前页面 =', cur || '(未就绪)');

    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    if (cards.length < 5) throw new Error(`首页卡片数异常: ${cards.length}`);
    try { await cards[0].tap(); } catch (e) { await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' }); }
    await sleep(3000);
    page = await miniProgram.currentPage();

    // 勾选授权
    const items = await page.$$('.consent__item');
    for (const it of items) { try { await it.tap(); } catch (_) {} }
    await sleep(300);

    // 注入图片并取图
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const tgt = `${userDataPath}/smoke_beauty.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      tgt,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [tgt],
      tempFiles: [{ path: tgt, size: b64.length }],
    });
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary');
    await btn.tap();

    // 等待美颜面板 head 出现（preview 区内）
    let head = null;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      head = await page.$('.beauty__head');
      if (head) break;
    }

    let panelOk = false;
    let forbiddenOk = false;
    if (head) {
      await head.tap(); // 展开
      await sleep(800);
      panelOk = !!(await page.$('.beauty__panel'));
      forbiddenOk = !!(await page.$('.beauty__forbidden'));
    }

    console.log('\n===== 受限美颜 冒烟结果 =====');
    console.log('  T1 美颜折叠头(.beauty__head):', head ? 'OK' : 'FAIL');
    console.log('  展开后面板(.beauty__panel):', panelOk ? 'OK' : 'FAIL');
    console.log('  合规禁用项(.beauty__forbidden, 灰置瘦脸/大眼):', forbiddenOk ? 'OK' : 'FAIL');
    console.log('  运行时错误数:', errors.length);
    if (errors.length) console.log(errors.join('\n'));

    const pass = !!head && panelOk && forbiddenOk && errors.length === 0;
    console.log(pass ? '✅ 受限美颜结构回归通过' : '❌ 受限美颜结构回归未通过');
    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
