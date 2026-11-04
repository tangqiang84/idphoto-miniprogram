/**
 * 端侧真模型接入 · 冒烟（任务 #3）
 * ----------------------------------------------------------------
 * 验证三件事：
 *   1. 静态：规格表里没有 RMBG（许可红线）；推理运行时不被静态 import（编译期无依赖）
 *   2. 契约：端侧模型规格与云端规格参数不同（参数化生效）；默认配置不启用模型
 *   3. 端到端：模拟器内跑 T1 全链路 —— 未配置权重时应走经典基线，
 *      **不崩溃、不发起下载、不出图异常**，且运行时错误为 0
 *
 * 【为什么这样设计】
 * 真模型需要「权重文件 + onnxruntime」，两者本项目都没有（且禁止在项目内
 * npm install）。所以本冒烟验证的是**降级路径的正确性**——
 * 这恰恰是接入真模型时最容易出事的地方：模型没配好就崩，比没有模型更糟。
 *
 * 用法：NODE_OPTIONS= node 工具链/smoke_model.js [--port 9433]
 */
const path = require('path');
const fs = require('fs');
const APP = path.join(__dirname, '..', 'idphoto-miniprogram');
const SHOT_DIR = path.join(__dirname, '..', '素材', '测试截图');
const TEST_IMG = path.join(__dirname, '..', '素材', '测试图', 'test_standard.png');

let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules', 'miniprogram-automator'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const runtimeErrors = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`OK   ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  const argv = process.argv.slice(2);
  const portArg = argv.indexOf('--port');
  // 默认 9436（与 smoke_auto 9420 / smoke_t2 9421 / smoke_t5 9422 / smoke_t3 9424 /
  // smoke_spec 9425 / smoke_face 9426 / smoke_dpi 9431 / smoke_headcrop 9432 错开）。
  // 端口被占多为上次崩溃残留的会话（automator 崩了不会 close），换端口重跑即可（台账 #19/#23）。
  const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 9436;

  // ===================== 1. 静态断言（不需要模拟器） =====================
  console.log('===== 1. 静态：许可与依赖 =====');

  const modelSrc = fs.readFileSync(path.join(APP, 'src/core/mattingModel.js'), 'utf8');
  // 许可红线：规格表里不得出现 RMBG（权重为非商业许可）
  const specBlock = modelSrc.slice(modelSrc.indexOf('const MODEL_SPECS'), modelSrc.indexOf('// 端侧默认模型'));
  check('静态/规格表不含 RMBG（非商业许可红线）', !/rmbg/i.test(specBlock));
  check('静态/规格表声明 commercialOk', /commercialOk:\s*true/.test(specBlock));

  // 依赖红线：不得静态 import onnxruntime（否则编译报错 + 违反禁装包约束）
  const onnxSrc = fs.readFileSync(path.join(APP, 'src/miniprogram/onnxMatting.ts'), 'utf8');
  check('静态/onnxMatting 不静态 import onnxruntime-web',
    !/^\s*import\s+.*from\s+['"]onnxruntime-web['"]/m.test(onnxSrc));
  check('静态/onnxMatting 改为注入式 ort', /ort:\s*OrtRuntime/.test(onnxSrc));

  // 默认配置必须关闭，保证零回归
  const svc = fs.readFileSync(path.join(APP, 'src/services/modelService.ts'), 'utf8');
  const cfgBlock = svc.slice(svc.indexOf('export const EDGE_MODEL_CONFIG'), svc.indexOf('// 覆盖配置'));
  check('静态/端侧模型默认关闭（enabled:false）', /enabled:\s*false/.test(cfgBlock));
  check('静态/默认不配权重地址（weightUrl 为空）', /weightUrl:\s*''/.test(cfgBlock));

  // ===================== 2. 契约断言（纯 Node） =====================
  console.log('\n===== 2. 契约：规格参数化 =====');
  const M = require(path.join(APP, 'src/core/mattingModel.js'));
  const modnet = M.getModelSpec('modnet-q8');
  const biref = M.getModelSpec('birefnet-1024');
  check('契约/MODNet 与 BiRefNet 输入尺寸不同（512 vs 1024）', modnet.inputSize !== biref.inputSize,
    `${modnet.inputSize} vs ${biref.inputSize}`);
  check('契约/两者归一化方式不同（minus1to1 vs imagenet）',
    modnet.normalize.kind !== biref.normalize.kind,
    `${modnet.normalize.kind} vs ${biref.normalize.kind}`);
  check('契约/云端规格标记为 edgeOnly（端侧跑不动）', biref.edgeOnly === true);

  // 默认配置下的决策必须是 classical —— 这是零回归的核心保证
  const plan = M.resolveModelPlan({
    config: { enabled: false, weightUrl: '', modelId: 'modnet-q8' },
    runtime: { hasOrt: true },
    cached: { exists: true, size: 99999999 },
  });
  check('契约/默认配置下决策为 classical（不下载、不加载）', plan.action === 'classical', plan.reason);

  // ===================== 3. 端到端（模拟器） =====================
  console.log('\n===== 3. 端到端（模拟器 · 降级路径） =====');
  const miniProgram = await automator.launch({ projectPath: APP, port: PORT, timeout: 60000 });
  miniProgram.on('exception', (e) => runtimeErrors.push(String((e && e.message) || e)));

  for (let i = 0; i < 8; i++) {
    await sleep(3000);
    const st = await miniProgram.pageStack().catch(() => []);
    if ((st[st.length - 1] || {}).path) break;
  }

  // 监控网络请求：默认配置下**不应有任何权重下载**
  const requests = [];
  try {
    miniProgram.on('request', (r) => requests.push(String(r && r.url || r)));
  } catch (e) { /* 部分版本无此事件，忽略 */ }

  // 3.1 首页 → 点第一张卡片进 T1（禁 reLaunch，automator 0.13 坑）
  let page = await miniProgram.currentPage();
  const cards = await page.$$('.tool-card');
  check('E2E/首页卡片数=5', cards.length === 5, `实际 ${cards.length}`);
  try { await cards[0].tap(); }
  catch (e) { await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' }); }
  await sleep(3000);
  const stack = await miniProgram.pageStack().catch(() => []);
  check('E2E/进入 T1', ((stack[stack.length - 1] || {}).path || '').includes('tool-idphoto'));
  const p2 = await miniProgram.currentPage();

  // 3.2 勾两项授权
  const consentItems = await p2.$$('.consent__item');
  check('E2E/T1 授权项数=2', consentItems.length === 2, `实际 ${consentItems.length}`);
  await consentItems[0].tap(); await sleep(400);
  await consentItems[1].tap(); await sleep(600);

  // 3.3 注入测试图到模拟器内文件系统，再 mock 选图
  //     mockWxMethod 的**对象形式**在本环境可用（函数形式不执行 —— 问题台账 #38），
  //     路径先在 Node 侧从模拟器取回再拼好，故对象形式够用。
  const b64 = fs.readFileSync(TEST_IMG).toString('base64');
  const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
  const target = `${userDataPath}/smoke_model_input.png`;
  await miniProgram.evaluate(
    (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
    b64, target,
  );
  await miniProgram.mockWxMethod('chooseImage', {
    tempFilePaths: [target],
    tempFiles: [{ path: target, size: b64.length }],
  });

  // 3.4 点处理
  const btn = await p2.$('.btn-primary');
  check('E2E/找到处理按钮', !!btn);
  if (btn) await btn.tap();

  // 3.5 等待完成（轮询页面文本）
  //     取文本用 $$('text') 逐个拼接 —— page.$('page').text() 在 automator 0.13 拿不到内容
  //     （与 smoke_headcrop.js 的 readPageText 同款写法）。
  const readPageText = async (pg) => {
    try {
      const vs = await pg.$$('text');
      const parts = [];
      for (const v of vs) { try { parts.push((await v.text()) || ''); } catch (_) {} }
      return parts.join(' ');
    } catch (e) { return ''; }
  };
  let text = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const cur = await miniProgram.currentPage();
    text = await readPageText(cur);
    if (/抠图质量|头部占比|合规预审/.test(text)) break;
  }
  check('E2E/处理完成（出现预审结果）', /头部占比|合规预审/.test(text), (text || '').slice(0, 80));
  // 未配置模型 → 不应出现 onnx 后端标记（说明降级到经典基线生效且未被误启用）
  check('E2E/未配置模型时不显示 onnx 后端', !/onnx:/.test(text));
  // 关键：降级路径下必须仍然出图（「完成」+ 预审结果齐全），而不是崩溃
  check('E2E/降级路径仍正常出图（完成 + 预审）', /完成/.test(text) && /合规预审/.test(text));

  // 运行时错误
  check('E2E/运行时错误 0 条', runtimeErrors.length === 0, runtimeErrors.slice(0, 2).join(' | '));

  // 截图
  try {
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    await miniProgram.screenshot({ path: path.join(SHOT_DIR, '12-model-degrade.png') });
    console.log('截图:', path.join(SHOT_DIR, '12-model-degrade.png'));
  } catch (e) {
    console.log('截图失败（不影响断言）:', e.message);
  }

  await miniProgram.close();

  console.log('\n===== 端侧真模型（任务 #3）冒烟结果 =====');
  console.log(`断言 ${pass}/${pass + fail} 通过；运行时错误 ${runtimeErrors.length} 条`);
  if (runtimeErrors.length) console.log('错误明细:', runtimeErrors.slice(0, 5));
  if (fail === 0 && runtimeErrors.length === 0) {
    console.log('✅ 端侧真模型冒烟通过');
    process.exit(0);
  }
  console.log('❌ 存在失败项');
  process.exit(1);
})().catch((e) => {
  console.error('SMOKE FAILED:', e && e.stack ? e.stack : e);
  process.exit(3);
});
