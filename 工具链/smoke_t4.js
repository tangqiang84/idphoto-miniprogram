/**
 * 证件照小程序 · 自动化冒烟（T4 合规检测，模拟器内无人值守）
 *
 * 复用 smoke_auto/t2/t5 的坑位经验：NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot /
 * mock 图先写入 USER_DATA_PATH。
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_t4.js
 *
 * 特点与断言：
 *   - AC5 反向：不勾 faceLocal 授权点检测 → 处理不启动（业务状态不变）
 *   - AC5 正向：勾授权 → mock 选图 → 真实测（尺寸/KB/底色/等效dpi）→ 报告渲染
 *   - faceDetect 降级：开发者工具无人脸检测 → 报告出现「未检测」（预期降级路径）
 *   - AC10 只读：页面不得出现「保存到相册」入口
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
const PORT = Number(getArg('--port', 9424));
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
    const vs = await page.$$('text');
    const parts = [];
    for (const v of vs) { try { parts.push((await v.text()) || ''); } catch (_) {} }
    return parts.join(' ');
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
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }

    // 1. 进 T4（第 4 张卡片，index 3）
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    console.log(`1) 首页工具卡片数 = ${cards.length} ${cards.length >= 5 ? 'OK' : 'FAIL(应≥5)'}`);
    if (cards.length < 5) throw new Error('首页卡片数异常');
    try {
      await cards[3].tap(); // 第 4 张 = 合规检测
    } catch (e) {
      console.log('1) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-check/index' });
    }
    await sleep(3000);
    page = await miniProgram.currentPage();
    const stack = await miniProgram.pageStack().catch(() => []);
    const onT4 = ((stack[stack.length - 1] || {}).path || '').includes('tool-check');
    console.log('1) 当前页面 =', (stack[stack.length - 1] || {}).path || '(未就绪)', onT4 ? 'OK' : 'FAIL(未进入 T4)');
    if (!onT4) throw new Error('未进入 T4 页面');

    // 2. AC5 反向：未勾授权点主按钮 → 不启动选图
    let txt = await readPageText(page);
    const hasConsent = txt.includes('需授权');
    console.log(`2) 授权区块存在: ${hasConsent ? 'OK' : 'FAIL'}`);
    if (!hasConsent) throw new Error('T4 缺少授权区块');
    let btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary');
    await btn.tap();
    await sleep(1500);
    txt = await readPageText(page);
    // 断言业务状态（未进入处理链路），不断言 Toast 文案——Toast 不在 DOM（#19 坑）
    const blocked = !txt.includes('读取图片') && !txt.includes('检测完成');
    console.log(`2) AC5 反向（未勾授权被阻断）: ${blocked ? 'OK' : 'FAIL'}`);

    // 3. 勾选 faceLocal 授权
    const consentItems = await page.$$('.consent__item');
    console.log(`3) 授权项数量 = ${consentItems.length}（T4 应为 1）`);
    if (consentItems.length < 1) throw new Error('T4 授权项缺失');
    await consentItems[0].tap();
    await sleep(800);

    // 4. 注入测试图 + mock chooseImage
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_t4.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });
    console.log('4) 已注入图片 + mock chooseImage →', target);

    // 5. 正向检测
    btn = await page.$('.btn-primary');
    await btn.tap();
    let done = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      txt = await readPageText(page);
      if (txt.includes('检测完成') || txt.includes('检测失败')) { done = true; break; }
    }
    await shot('06-t4.png');

    // 6. 断言报告与 AC10
    const hasReport = txt.includes('综合结论') && txt.includes('尺寸') && txt.includes('底色');
    const headDegrade = txt.includes('未检测'); // 开发者工具无人脸检测 → 预期降级
    const noSave = !txt.includes('保存到相册'); // AC10：只读，不得有保存入口

    const pass =
      blocked && done && !txt.includes('检测失败') &&
      hasReport && noSave && errors.length === 0;

    console.log('\n===== T4 冒烟结果 =====');
    console.log('AC5 反向阻断:', blocked ? 'OK' : 'FAIL');
    console.log('检测完成:', done ? (txt.includes('检测失败') ? 'FAIL(失败文案)' : 'OK') : 'FAIL(超时45s)');
    console.log('报告渲染（综合结论/尺寸/底色）:', hasReport ? 'OK' : 'FAIL');
    console.log('faceDetect 降级为未检测:', headDegrade ? 'OK（预期，开发者工具不支持）' : '（未出现——若真机跑应出现实测值）');
    console.log('AC10 无保存入口:', noSave ? 'OK' : 'FAIL(出现了保存到相册)');
    console.log('运行时错误数:', errors.length);
    if (txt) console.log('页面文本:', txt.replace(/\s+/g, ' ').slice(0, 500));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '06-t4.png'));
    console.log(pass ? '✅ T4 冒烟通过（合规检测主链路在模拟器内跑通）' : '❌ T4 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
