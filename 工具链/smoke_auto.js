/**
 * 证件照小程序 · 自动化冒烟（T1 主链路，模拟器内无人值守）
 *
 * 前置（一次性）：微信开发者工具 → 设置 → 安全设置 → **服务端口：开启**（台账 #19）
 * 依赖：miniprogram-automator 装于隔离工作区（勿装进项目 node_modules，会重排 webpack）
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_auto.js
 *   NODE_OPTIONS= node 工具链/smoke_auto.js --img 素材/测试图/test_complex.png
 *
 * 流程：
 *   连接 IDE → 断言首页 5 张卡片 → 点 T1 → 勾选全部授权 →
 *   把测试图写入小程序沙箱(USER_DATA_PATH) → mock chooseImage 返回该路径 →
 *   点「选择照片并制作」→ 轮询页面文本直到"完成/失败" → 采集 [audit] → 截图 → PASS/FAIL
 *
 * 坑位记录（别再踩）：
 *   1. 命令必须 `NODE_OPTIONS=` 前缀，否则沙箱 fs 拦截层拦写盘（台账 #11）
 *   2. automator 0.13：**不要用 miniProgram.reLaunch()**（内部 getPageMetaByWebviewId 返回 null 直接崩）；
 *      用 currentPage() + 点击卡片导航
 *   3. Page 对象**没有 screenshot/path()**；截图用 miniProgram.screenshot()，路径用 pageStack()
 *   4. mock chooseImage 不能直接给 macOS 绝对路径（小程序沙箱读不到），需先 inject 到 USER_DATA_PATH
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

    // 0. 当前页面（不用 reLaunch，见坑位 2）；轮询等待页面就绪
    let curPath;
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      curPath = (st[st.length - 1] || {}).path;
      if (curPath) break;
    }
    console.log('0) 当前页面 =', curPath || '(未就绪)');
    if (!curPath) {
      console.log('   ⚠️ 拿不到页面栈。请在 IDE 模拟器里手动打开小程序首页后重跑。');
    } else if (curPath !== 'pages/home/index') {
      console.log('   ⚠️ 不在首页，尝试 navigateTo 回首页…');
      try { await miniProgram.navigateTo({ url: '/pages/home/index' }); await sleep(3000); }
      catch (e) { console.log('   navigateTo 失败:', e.message); }
    }

    // 1. 首页断言
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    await shot('01-home.png');
    console.log(`1) 首页工具卡片数 = ${cards.length} ${cards.length >= 5 ? 'OK' : 'FAIL(应≥5)'}`);
    if (cards.length < 5) throw new Error('首页卡片数异常，检查 home/index.tsx 或当前页面');

    // 2. 进 T1（tap 会触发页面切换，可能与本版本 automator 不兼容 → 失败则改 navigateTo）
    try {
      await cards[0].tap();
    } catch (e) {
      console.log('2) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' });
    }
    await sleep(3000);
    page = await miniProgram.currentPage();
    const stack = await miniProgram.pageStack().catch(() => []);
    console.log('2) 当前页面 =', (stack[stack.length - 1] || {}).path || '(未就绪)');

    // 3. 勾选授权（AC5：默认不勾选）。--skip-consent 则不勾，用于反向验证 AC5 阻断
    const SKIP_CONSENT = args.includes('--skip-consent');
    const items = await page.$$('.consent__item');
    if (!SKIP_CONSENT) {
      for (const it of items) await it.tap();
      await sleep(300);
    }
    console.log(`3) 授权项共 ${items.length}，${SKIP_CONSENT ? '【反向用例】故意不勾选' : '已全部勾选'}`);

    // 4. 把测试图写入小程序沙箱（坑位 4）
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_test.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    console.log('4) 已注入图片 →', target);

    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });

    // 5. 点主按钮
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
    await btn.tap();
    console.log('5) 已点击「选择照片并制作」，等待处理…');

    // 6. 轮询结果
    let msg = '';
    let finished = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
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
        if (txt) msg = txt;
        if (txt.includes('完成') || txt.includes('失败')) { finished = true; break; }
      } catch (e) { /* 页面切换中 */ }
    }
    await shot('02-t1.png');

    const auditLogs = logs.filter((l) => l.includes('[audit]'));

    if (SKIP_CONSENT) {
      // 反向用例：未授权必须被阻断（AC5）。
      // 注意：阻断提示是 Toast（浮层，不在 DOM 文本里），所以判定依据 =
      // 页面从未进入处理状态（无"读取图片/抠图处理中/完成"字样）
      const entered = msg.includes('读取图片') || msg.includes('抠图处理中') || msg.includes('完成');
      const blocked = !entered;
      console.log('\n===== AC5 反向用例 =====');
      console.log('未授权时被阻断（未进入处理链路）:', blocked ? 'OK（AC5 通过）' : `FAIL，页面文本: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
      console.log(blocked ? '✅ AC5 反向通过' : '❌ AC5 反向未通过 → 登记《问题台账》');
      await miniProgram.close();
      process.exit(blocked ? 0 : 1);
    }

    const pass = finished && msg.includes('完成') && errors.length === 0;

    console.log('\n===== 冒烟结果 =====');
    console.log('处理完成:', finished ? (msg.includes('完成') ? 'OK' : 'FAIL(失败文案)') : 'FAIL(超时45s)');
    console.log('运行时错误数:', errors.length);
    console.log('audit 日志:', auditLogs.length ? auditLogs.join(' | ') : '（无 → 说明未触发上云增强）');
    if (msg) console.log('页面文本:', msg.replace(/\s+/g, ' ').slice(0, 300));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', SHOTS);
    console.log(pass ? '✅ 冒烟通过（T1 主链路在模拟器内跑通）' : '❌ 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
