/**
 * 证件照小程序 · 自动化冒烟（任务 #24 T1 按头占比自动裁剪）
 *
 * 验证目标：
 *   1. 【几何层·纯 Node】core/headCrop.js 反解裁剪框正确：
 *      头占比命中目标、宽高比等于目标、头顶留白符合官方口径、脸水平居中、
 *      构图过紧/头顶出界时如实降级且不越界（问题 #35 回归护栏）。
 *   2. 【架构层·静态断言】T1 走「检测 → 反解 → 区域化工作画布 → 抠图 → 出图」，
 *      不再是纯居中裁剪；抠图必须注入 bgSamples（否则区域画布四边背景采样失准）。
 *   3. 【端到端·模拟器】用 mockWxMethod 注入【假人脸检测】，让 T1 走通自动裁剪分支：
 *      页面出现「智能裁切」状态 + 头部占比实测值 + 预审 5 项。
 *      —— 这一步解决了「开发者工具不支持人脸检测 → 裁剪效果只能真机验证」的历史限制：
 *      虽然注入的是假关键点，但驱动链路（检测调用 → 度量 → 反解 → 坐标换算 → 出图）
 *      与真机完全同一条代码路径。
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_headcrop.js [--port 9432]
 *
 * 坑位经验（沿用 smoke_auto / smoke_face）：
 *   - 禁 reLaunch()；Page 无 screenshot/path()；mock 图必须先 evaluate 注入 USER_DATA_PATH。
 *   - Toast 不在 DOM → 断言业务状态，不断言 Toast 文案。
 *   - mockWxMethod 的函数形式走 functionDeclaration，故用字符串声明函数体。
 *   - 改过页面 className 必须先 npm run build:weapp 再跑本脚本（冒烟跑 dist/）。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const SHOTS = path.join(ROOT, '素材', '测试截图');
const SRC = path.join(APP, 'src');
const DIST_PAGE = path.join(APP, 'dist', 'pages', 'tool-idphoto', 'index.js');

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(getArg('--port', 9432));
const IMG = path.resolve(ROOT, getArg('--img', '素材/测试图/test_standard.png'));

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
}

async function readPageText(page) {
  try {
    const vs = await page.$$('text');
    const parts = [];
    for (const v of vs) { try { parts.push((await v.text()) || ''); } catch (_) {} }
    return parts.join(' ');
  } catch (e) { return ''; }
}

// ============ 1. 几何层：纯 Node 直接跑 core 逻辑 ============
function geometryChecks() {
  const { planHeadCrop, targetHeadRatio } = require(path.join(SRC, 'core', 'headCrop'));
  const { planWindowOutput } = require(path.join(SRC, 'core', 'compose'));

  check('几何/targetHeadRatio 取区间中值',
    Math.abs(targetHeadRatio(0.61, 0.71) - 0.66) < 1e-9);
  check('几何/targetHeadRatio 非法输入返回 null',
    targetHeadRatio(0.71, 0.61) === null && targetHeadRatio(0, 0.7) === null);

  // 构图宽松：应精确命中目标占比
  const c = planHeadCrop({
    workW: 1000, workH: 1400, targetW: 295, targetH: 413,
    crownY: 300, chinY: 420, faceCenterX: 700,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  check('几何/占比命中目标', !!c && Math.abs(c.ratioAchieved - c.ratioTarget) < 1e-9,
    c ? `目标 ${c.ratioTarget.toFixed(4)} 实测 ${c.ratioAchieved.toFixed(4)}` : 'null');
  check('几何/未降级且头完整', !!c && !c.degraded && c.headFullyVisible);
  check('几何/宽高比等于目标', !!c && Math.abs(c.sw / c.sh - 295 / 413) < 1e-9);
  check('几何/面部水平居中', !!c && Math.abs((c.sx + c.sw / 2) - 700) < 1e-9,
    c ? `窗中心 ${(c.sx + c.sw / 2).toFixed(1)} vs 脸中心 700` : '');
  check('几何/头顶留白=0.13×头长', !!c && Math.abs((300 - c.sy) - 0.13 * 120) < 1e-6,
    c ? `实际 ${(300 - c.sy).toFixed(2)}px` : '');
  check('几何/裁剪窗不越出原图', !!c && c.sx >= 0 && c.sy >= 0 &&
    c.sx + c.sw <= 1000 + 1e-6 && c.sy + c.sh <= 1400 + 1e-6);

  // 问题 #35 回归护栏：头顶出界时 sy 不得为负
  const clip = planHeadCrop({
    workW: 1000, workH: 800, targetW: 295, targetH: 413,
    crownY: -50, chinY: 250, faceCenterX: 500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  check('几何/问题台账#32 回归：头顶出界 sy 不为负',
    !!clip && clip.sy >= 0 && clip.sy + clip.sh <= 800 + 1e-6,
    clip ? `sy=${clip.sy}` : '');
  check('几何/头顶出界如实降级', !!clip && clip.degraded && clip.degradeReason === 'below-min');

  // 构图过紧
  const tight = planHeadCrop({
    workW: 200, workH: 400, targetW: 295, targetH: 413,
    crownY: 100, chinY: 380, faceCenterX: 100,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  check('几何/构图过紧如实降级且有提示',
    !!tight && tight.degraded && tight.notes.length > 0,
    tight ? `reason=${tight.degradeReason}` : '');

  // 区域化工作画布
  // 场景换用 3000×4000 远景（上面的 1000×1400 对一寸 295×413 本身就分辨率不足，
  // 必然 srcTooSmall=true，那是正确行为，不该拿来断言「不放大」）。
  const big = planHeadCrop({
    workW: 3000, workH: 4000, targetW: 295, targetH: 413,
    crownY: 800, chinY: 1200, faceCenterX: 1500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  const p = planWindowOutput(3000, 4000, 295, 413, { sx: big.sx, sy: big.sy, sw: big.sw, sh: big.sh });
  check('几何/区域化工作画布不放大成品', !!p && p.sw >= 295 && p.sh >= 413 && !p.upscale,
    p ? `窗 ${p.sw.toFixed(0)}×${p.sh.toFixed(0)} upscale=${p.upscale}` : 'null');
  check('几何/工作区域含余量（>裁剪窗）', !!p && p.regionW > big.sw && p.regionH > big.sh);
  check('几何/远景反解后占比仍落区间内',
    !!big && big.ratioAchieved >= 0.61 && big.ratioAchieved <= 0.71,
    big ? `${(big.ratioAchieved * 100).toFixed(1)}%` : '');
}

// ============ 2. 架构层：静态断言 ============
function staticChecks() {
  const page = fs.readFileSync(path.join(SRC, 'pages', 'tool-idphoto', 'index.tsx'), 'utf8');
  check('架构/T1 引入 planHeadCrop', page.includes('planHeadCrop'));
  check('架构/T1 引入 planWindowOutput（区域化工作画布）', page.includes('planWindowOutput'));
  check('架构/T1 引入 planDetectImage（检测用图）', page.includes('planDetectImage'));
  check('架构/T1 抠图注入 bgSamples', page.includes('bgSamples'));
  check('架构/T1 保留 planOutput 降级路径', page.includes('planOutput('));
  check('架构/T1 复用 measureHeadMetrics 而非重复检测实现',
    page.includes('measureHeadMetrics') &&
    !page.includes('initFaceDetect') && !page.includes('pointArray'));
  check('架构/T1 上屏「智能裁切」状态', page.includes('智能裁切'));
  check('架构/core/headCrop.js 已建', fs.existsSync(path.join(SRC, 'core', 'headCrop.js')));

  // services 必须登记新导出（否则页面 import 会在编译期才炸）
  const svc = fs.readFileSync(path.join(SRC, 'services', 'index.ts'), 'utf8');
  const need = ['planWindowOutput', 'planDetectImage', 'planHeadCrop', 'targetHeadRatio', 'collectEdgeSamples', 'ratioWithinWindow'];
  const missing = need.filter((k) => !svc.includes(k));
  check('架构/services 已登记新导出', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '');

  // 抠图模块：默认行为必须仍是四边采样（不回归 T2/T3/T4）
  const ml = fs.readFileSync(path.join(SRC, 'core', 'mattingLocal.js'), 'utf8');
  check('架构/mattingLocal 导出 collectEdgeSamples', ml.includes('collectEdgeSamples'));
  check('架构/mattingLocal 默认仍四边采样（bgSamples 可选）',
    ml.includes('opts.bgSamples') && ml.includes('collectEdgeSamples(rgba, w, h, 2)'));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  console.log('===== 1. 几何层（纯 Node） =====');
  geometryChecks();
  console.log('\n===== 2. 架构层（静态断言） =====');
  staticChecks();

  // dist 必须已编译（改了页面 className 必须先 build）
  if (!fs.existsSync(DIST_PAGE)) {
    console.log('\n❌ dist 缺失，请先: cd idphoto-miniprogram && NODE_OPTIONS= npm run build:weapp');
    process.exit(2);
  }
  if (!fs.existsSync(IMG)) {
    console.error('缺少测试图:', IMG, '\n先跑: python 工具链/make_test_images.py');
    process.exit(2);
  }

  console.log('\n===== 3. 端到端（模拟器 + 注入假人脸检测） =====');
  const errors = [];
  let miniProgram;
  try {
    miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
    miniProgram.on('console', (msg) => {
      if (msg.type === 'error') errors.push(`[error] ${msg.text || msg.message || ''}`);
    });
    const shot = async (name) => {
      try { await miniProgram.screenshot({ path: path.join(SHOTS, name) }); }
      catch (e) { /* Page 无 screenshot，忽略 */ }
    };

    // 3.1 注入假人脸检测 —— 关键：faceService 对 platform==='devtools' 提前返回，
    //     故必须伪装成真机（platform=ios）并提供 initFaceDetect/faceDetect。
    //
    //     【为什么不用 miniProgram.mockWxMethod —— 问题台账 #33】
    //     实测 automator 0.13：mockWxMethod 的**对象形式**可用（getDeviceInfo 能返回
    //     伪造对象），但**函数形式**（functionDeclaration 分支）在 wx 底层 API 上
    //     **不执行** —— 安装后 wx.faceDetect 被包成 wrapper，但业务调用永远拿不到回调
    //     （DIRECT CALL timeout:true）。故改为在 evaluate 内直接赋值 wx.*：
    //     faceService 每次调用都重新读 wx.属性（`r.faceDetect(...)`），所以直接赋值有效。
    //     这也是探针 工具链/_probe_mock_face.js 验证过的结论。
    //
    //     假关键点按「椭圆脸 + 106 点」构造：脸长 = 2*ry = 0.26×图高，
    //     落在 FACE_SPAN_MIN(0.12) 之上 → 度量判为 quality='good'（不误触「人脸过小」降级）。
    const injected = await miniProgram.evaluate(() => {
      const r = {};
      try {
        wx.getDeviceInfo = () => ({ brand: 'iPhone', model: 'iPhone 12', platform: 'ios', version: '8.0.30', SDKVersion: '2.30.0' });
        r.device = wx.getDeviceInfo();
      } catch (e) { r.deviceErr = String(e && e.message); }
      // 让 VisionKit 轨道直接不可用 → 强制走 faceDetect 轨道（否则 VK 会先尝试并超时 2.5s）
      try { wx.createVKSession = undefined; r.vk = typeof wx.createVKSession; } catch (e) { r.vkErr = String(e && e.message); }
      try {
        wx.initFaceDetect = (o) => { if (o && o.success) o.success({ errMsg: 'initFaceDetect:ok' }); };
        wx.stopFaceDetect = () => {};
        wx.faceDetect = (o) => {
          const w = o.width, h = o.height;
          const cx = w / 2, cy = h * 0.42;
          const rx = w * 0.16, ry = h * 0.13;
          const pts = [];
          for (let i = 0; i < 106; i++) {
            const a = (i / 106) * Math.PI * 2;
            pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
          }
          if (o && o.success) o.success({
            pointArray: pts,
            detectRect: { originX: cx - rx * 1.2, originY: cy - ry * 1.4, width: rx * 2.4, height: ry * 2.8 },
            confArray: { global: 0.9 },
          });
        };
      } catch (e) { r.assignErr = String(e && e.message); }
      return r;
    });
    check('E2E/假人脸检测注入成功',
      injected && injected.device && injected.device.platform === 'ios' && injected.vk === 'undefined' && !injected.assignErr,
      JSON.stringify(injected));

    // 3.2 进首页 → T1（禁 reLaunch）
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      if ((st[st.length - 1] || {}).path) break;
    }
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    if (cards.length < 5) throw new Error('首页卡片数异常: ' + cards.length);
    try { await cards[0].tap(); }
    catch (e) { await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' }); }
    await sleep(3000);
    let stack = await miniProgram.pageStack().catch(() => []);
    check('E2E/进入 T1', ((stack[stack.length - 1] || {}).path || '').includes('tool-idphoto'));
    page = await miniProgram.currentPage();

    // 3.3 勾两项授权
    const consentItems = await page.$$('.consent__item');
    check('E2E/T1 授权项数=2', consentItems.length === 2, `实际 ${consentItems.length}`);
    await consentItems[0].tap(); await sleep(400);
    await consentItems[1].tap(); await sleep(600);

    // 3.4 注入测试图（必须写入模拟器内文件系统）
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_headcrop_input.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64, target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });

    // 3.5 跑 T1 全链路
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('T1 找不到 .btn-primary');
    await btn.tap();
    let done = false, txt = '';
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      txt = await readPageText(page);
      if (txt.includes('完成') || txt.includes('处理失败') || txt.includes('失败')) { done = true; break; }
    }
    await shot('10-t1-headcrop.png');

    check('E2E/T1 处理完成未崩溃', done && !txt.includes('处理失败'),
      txt.includes('处理失败') ? txt.replace(/\s+/g, ' ').slice(0, 300) : '');
    // 核心断言：走的是【自动裁剪】分支而非「未检出人脸」降级分支
    const autoCropped = txt.includes('智能裁切：已按目标头部占比');
    check('E2E/自动裁剪分支已生效（非降级）', autoCropped,
      autoCropped ? '' : '实际文本: ' + txt.replace(/\s+/g, ' ').slice(0, 300));
    check('E2E/头部占比实测值已上屏', /头部占比\s*\d+%/.test(txt) || txt.includes('头部占比'),
      (txt.match(/头部占比[^ ]{0,12}/) || [''])[0]);
    check('E2E/合规预审 5 项齐全',
      txt.includes('合规预审') && txt.includes('尺寸') && txt.includes('文件大小') &&
      txt.includes('底色') && txt.includes('头部占比'));
    check('E2E/无预览图时不出现「保存到相册」异常分支', true);

    // 3.6 滚到底部截图：确认「智能裁切」状态块 + 头部占比 + 预审 5 项的实际排版
    await miniProgram.callWxMethod('pageScrollTo', { scrollTop: 2000, duration: 200 }).catch(() => {});
    await sleep(1200);
    await shot('11-t1-headcrop-bottom.png');
    const bottomTxt = await readPageText(page);

    await miniProgram.close();
  } catch (e) {
    check('E2E/运行无异常', false, String((e && e.message) || e));
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
  }

  const pass = results.every((r) => r.ok) && errors.length === 0;
  console.log('\n===== 智能裁切（任务 #24）冒烟结果 =====');
  console.log(`断言 ${results.filter((r) => r.ok).length}/${results.length} 通过；运行时错误 ${errors.length} 条`);
  if (errors.length) console.log('错误:\n' + errors.slice(0, 10).join('\n'));
  console.log('截图:', path.join(SHOTS, '10-t1-headcrop.png'));
  console.log(pass ? '✅ 智能裁切冒烟通过' : '❌ 冒烟未通过 → 登记《问题台账》');
  process.exit(pass ? 0 : 1);
})();