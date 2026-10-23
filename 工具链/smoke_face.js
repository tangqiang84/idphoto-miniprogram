/**
 * 证件照小程序 · 自动化冒烟（任务 #4 人脸定位统一接入）
 *
 * 验证目标：
 *   1. T1 一键证件照：预审结果中出现「头部占比」项（PRD B3 / T1-16 从"未做"转"已做"）；
 *      当前环境无脸检测能力 → 走降级路径，头部占比显示「未检测到人脸」但**其余 4 项照常预审**。
 *   2. T4 合规检测：报告出现「未检测」降级提示（预期降级路径），且仍无「保存到相册」入口（AC10）。
 *   3. 代码层：三处页面不再各自实现人脸检测 —— 统一走 services/faceService。
 *      （静态断言：页面源码中不再出现 initFaceDetect / pointArray 等重复实现痕迹）
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_face.js
 *
 * 坑位经验（沿用 smoke_auto / smoke_t2 / smoke_t4）：
 *   - 禁 reLaunch()；Page 无 screenshot/path()；mock 图必须先 evaluate 注入 USER_DATA_PATH。
 *   - Toast 不在 DOM → 断言业务状态，不断言 Toast 文案。
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
const PORT = Number(getArg('--port', 9426));
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

// 静态断言：三个页面的源码里不得再出现平台人脸检测的直接调用
function checkNoDuplicateImpl() {
  const targets = [
    path.join(SRC, 'pages', 'tool-idphoto', 'index.tsx'),
    path.join(SRC, 'pages', 'tool-check', 'index.tsx'),
    path.join(SRC, 'pages', 'tool-suit', 'index.tsx'),
  ];
  const forbidden = ['initFaceDetect', 'pointArray', 'stopFaceDetect', 'createVKSession'];
  const problems = [];
  for (const f of targets) {
    const src = fs.readFileSync(f, 'utf8');
    for (const kw of forbidden) {
      if (src.includes(kw)) problems.push(`${path.basename(path.dirname(f))}: ${kw}`);
    }
  }
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

  // ---- 0. 静态检查：无重复实现 ----
  const dupProblems = checkNoDuplicateImpl();
  console.log('0) 页面层无重复人脸检测实现:', dupProblems.length === 0 ? 'OK' : 'FAIL ' + dupProblems.join(', '));

  // ---- 0.1 确认统一服务存在 ----
  const svcPath = path.join(SRC, 'services', 'faceService.ts');
  const corePath = path.join(SRC, 'core', 'face.js');
  const svcExists = fs.existsSync(svcPath) && fs.existsSync(corePath);
  console.log('0) 统一服务与 core 模块存在:', svcExists ? 'OK' : 'FAIL');
  const svcSrc = svcExists ? fs.readFileSync(svcPath, 'utf8') : '';
  const hasVK = svcSrc.includes('createVKSession');
  const hasFD = svcSrc.includes('initFaceDetect');
  console.log('0) 双轨实现（VisionKit + faceDetect）:', hasVK && hasFD ? 'OK' : `FAIL(VK=${hasVK} FD=${hasFD})`);

  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
      if (msg.type === 'error') {
        // 完整对象落盘，便于定位空文本错误的真实来源
        errors.push(t + ' :: ' + JSON.stringify(msg));
        try { fs.appendFileSync(path.join(SHOTS, '..', 'smoke_face_errors.log'), JSON.stringify(msg) + '\n'); } catch (_) {}
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

    // 2. 进 T1（第 1 张卡片）
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    if (cards.length < 5) throw new Error('首页卡片数异常: ' + cards.length);
    try {
      await cards[0].tap();
    } catch (e) {
      console.log('  tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' });
    }
    await sleep(3000);
    let stack = await miniProgram.pageStack().catch(() => []);
    const onT1 = ((stack[stack.length - 1] || {}).path || '').includes('tool-idphoto');
    console.log('1) 进入 T1:', onT1 ? 'OK' : 'FAIL');
    if (!onT1) throw new Error('未进入 T1 页面');
    page = await miniProgram.currentPage();

    // 3. 勾选两项授权（T1 = faceLocal + faceCloudEnhance）
    const consentItems = await page.$$('.consent__item');
    console.log(`2) T1 授权项数 = ${consentItems.length}（应为 2）`);
    if (consentItems.length < 2) throw new Error('T1 授权项缺失');
    await consentItems[0].tap();
    await sleep(500);
    await consentItems[1].tap();
    await sleep(800);

    // 4. 注入测试图 + mock chooseImage
    // 注意：图片必须写入【模拟器内】的文件系统（wx.getFileSystemManager().writeFileSync），
    // Node 侧 fs.writeFileSync 写不到模拟器沙箱（USER_DATA_PATH 是模拟器内路径）。
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_face_input.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });

    // 5. 跑 T1 全链路
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('T1 找不到 .btn-primary');
    await btn.tap();
    let done = false;
    let txt = '';
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      txt = await readPageText(page);
      if (txt.includes('完成') || txt.includes('失败') || txt.includes('处理失败')) { done = true; break; }
    }
    await shot('08-t1-face.png');

    // 6. 断言 T1：预审 4 项 + 头部占比项已接入
    const t1HasCheck = txt.includes('合规预审');
    const t1HasHead = txt.includes('头部占比');
    const t1HasOther = txt.includes('尺寸') && txt.includes('文件大小') && txt.includes('底色');
    const t1NoCrash = !txt.includes('处理失败');
    console.log('3) T1 预审区块渲染:', t1HasCheck ? 'OK' : 'FAIL');
    console.log('3) T1 头部占比项已接入:', t1HasHead ? 'OK' : 'FAIL');
    console.log('3) T1 其余预审项照常:', t1HasOther ? 'OK' : 'FAIL');
    console.log('3) T1 处理无崩溃:', t1NoCrash && done ? 'OK' : 'FAIL');

    // ---- 7. 进 T4 ----
    // 返回首页
    await miniProgram.navigateBack().catch(() => {});
    await sleep(2000);
    stack = await miniProgram.pageStack().catch(() => []);
    // 若不在首页则直接导航
    if (!((stack[stack.length - 1] || {}).path || '').includes('pages/home')) {
      await miniProgram.switchTab && (await miniProgram.switchTab({ url: '/pages/home/index' }).catch(() => {}));
      await sleep(2000);
    }
    page = await miniProgram.currentPage();
    const cards2 = await page.$$('.tool-card');
    if (cards2.length < 5) throw new Error('回首页后卡片数异常');
    await cards2[3].tap();
    await sleep(3000);
    stack = await miniProgram.pageStack().catch(() => []);
    const onT4 = ((stack[stack.length - 1] || {}).path || '').includes('tool-check');
    console.log('4) 进入 T4:', onT4 ? 'OK' : 'FAIL');
    if (!onT4) throw new Error('未进入 T4 页面');
    page = await miniProgram.currentPage();

    // 8. T4 勾授权 + 跑检测
    const t4Consent = await page.$$('.consent__item');
    if (t4Consent.length < 1) throw new Error('T4 授权项缺失');
    await t4Consent[0].tap();
    await sleep(800);
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });
    const btn4 = await page.$('.btn-primary');
    if (!btn4) throw new Error('T4 找不到 .btn-primary');
    await btn4.tap();
    let done4 = false;
    let txt4 = '';
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      txt4 = await readPageText(page);
      if (txt4.includes('检测完成') || txt4.includes('检测失败')) { done4 = true; break; }
    }
    await shot('09-t4-face.png');

    const t4HasReport = txt4.includes('综合结论') && txt4.includes('尺寸') && txt4.includes('底色');
    const t4HeadDegrade = txt4.includes('未检测'); // 开发者工具无人脸检测 → 预期降级
    const t4NoSave = !txt4.includes('保存到相册');   // AC10
    console.log('4) T4 报告渲染:', t4HasReport ? 'OK' : 'FAIL');
    console.log('4) T4 头占比降级提示:', t4HeadDegrade ? 'OK（预期降级路径）' : '（未出现——真机应出现实测值）');
    console.log('4) T4 AC10 无保存入口:', t4NoSave ? 'OK' : 'FAIL');

    const pass =
      dupProblems.length === 0 && svcExists && hasVK && hasFD &&
      done && t1HasCheck && t1HasHead && t1HasOther && t1NoCrash &&
      done4 && t4HasReport && t4NoSave &&
      errors.length === 0;

    console.log('\n===== 人脸定位统一接入 冒烟结果 =====');
    console.log('运行时错误数:', errors.length);
    if (txt) console.log('T1 页面文本:', txt.replace(/\s+/g, ' ').slice(0, 400));
    if (txt4) console.log('T4 页面文本:', txt4.replace(/\s+/g, ' ').slice(0, 400));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '08-t1-face.png'), path.join(SHOTS, '09-t4-face.png'));
    console.log(pass ? '✅ 人脸定位统一接入冒烟通过' : '❌ 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
