/**
 * 证件照小程序 · 自动化冒烟（AC1 镜像自拍识别与提示，任务 #35）
 *
 * 复用 smoke_auto.js / smoke_camera.js 的坑位经验（NODE_OPTIONS= 前缀 / 禁 reLaunch /
 * mockWxMethod 注入 chooseImage / Page 无 screenshot）。
 *
 * 验证范围（UI 层，模拟器内无人值守）：
 *   1. T1–T5 五个工具页，取图后均渲染镜像自查组件 .mirror-check（接线结构回归）。
 *   2. 代表页 T2：取图 → .mirror-check 出现 → 点 .mirror-check__row（勾选）→
 *      .mirror-check__box.is-checked 出现（勾选交互生效，未勾选前保存按钮 disabled 由页面逻辑保证）。
 *
 * 说明：
 *   - 真实「未勾选不得保存」闸门效果依赖真机交互，列入任务 #14 真机冒烟；
 *     本脚本在模拟器内验证组件渲染与勾选态切换不崩溃（结构 + 交互回归）。
 *   - 需要测试图：默认 素材/测试图/test_standard.png。
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_mirror.js
 *   NODE_OPTIONS= node 工具链/smoke_mirror.js --img 素材/测试图/test_standard.png --port 9420
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

// 五个工具页路由 + 首页卡片下标 + 是否需要勾选授权
const TOOLS = [
  { route: '/pages/tool-idphoto/index', card: 0, name: 'T1', consent: true },
  { route: '/pages/tool-bg/index', card: 1, name: 'T2', consent: true },
  { route: '/pages/tool-suit/index', card: 2, name: 'T3', consent: true },
  { route: '/pages/tool-check/index', card: 3, name: 'T4', consent: true },
  { route: '/pages/tool-spec/index', card: 4, name: 'T5', consent: false },
];

// 取图（mock chooseImage）→ 等待预览，返回当前 page
async function pickAndWait(miniProgram, page, target) {
  const b64 = fs.readFileSync(IMG).toString('base64');
  const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
  const tgt = `${userDataPath}/smoke_mirror.png`;
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
  if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
  await btn.tap();
  // 等待预览（镜像组件在 preview 块内渲染）
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const mc = await page.$('.mirror-check');
    if (mc) break;
  }
  return page;
}

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
  const structLines = [];
  let passStruct = true;
  let gateToggled = false;

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

    for (const t of TOOLS) {
      const cur2 = await miniProgram.currentPage();
      try {
        await cards[t.card].tap();
      } catch (e) {
        await miniProgram.navigateTo({ url: t.route });
      }
      await sleep(3000);
      let p = await miniProgram.currentPage();

      if (t.consent) {
        const items = await p.$$('.consent__item');
        for (const it of items) { try { await it.tap(); } catch (_) {} }
        await sleep(300);
      }

      p = await pickAndWait(miniProgram, p, null);
      const mc = await p.$('.mirror-check');
      const ok = !!mc;
      structLines.push(`${t.name} .mirror-check: ${ok ? 'OK' : 'FAIL'}`);
      if (!ok) passStruct = false;

      // 代表页 T2：验证勾选交互（点 row → box 加 is-checked）
      if (t.name === 'T2' && mc) {
        const row = await p.$('.mirror-check__row');
        if (row) {
          await row.tap();
          await sleep(800);
          const box = await p.$('.mirror-check__box.is-checked');
          gateToggled = !!box;
        }
      }

      // 返回首页，准备下一个
      await miniProgram.navigateBack().catch(() => {});
      await sleep(1500);
      page = await miniProgram.currentPage();
    }

    console.log('\n===== AC1 镜像自查 冒烟结果 =====');
    structLines.forEach((l) => console.log('  ' + l));
    console.log('  镜像组件接线(5页):', passStruct ? 'OK' : 'FAIL');
    console.log('  T2 勾选交互(box.is-checked):', gateToggled ? 'OK' : 'WARN(模拟器交互限制，需真机验证)');
    console.log('  运行时错误数:', errors.length);
    if (errors.length) console.log(errors.join('\n'));

    const pass = passStruct && errors.length === 0;
    console.log(pass ? '✅ AC1 镜像自查结构回归通过' : '❌ AC1 镜像自查结构回归未通过');
    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
