/**
 * 证件照小程序 · 自动化冒烟（规格库官方口径专项，任务 #8 / 问题 #13）
 *
 * 复用 smoke_auto.js / smoke_t2.js / smoke_t5.js 的全部坑位经验：
 *   NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot / mock 图先写入 USER_DATA_PATH
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_spec.js
 *   NODE_OPTIONS= node 工具链/smoke_spec.js --img 素材/测试图/test_standard.png
 *
 * 背景：2026-10-23 裁决「PRD vs 代码规格数值偏差」，以官方口径为准：
 *   · 新增独立「驾驶证」规格（22×32mm = 260×378px，白底）
 *   · 美签 50.8mm → 600×600px（官方 DS-160 硬指标）
 *   · 蓝底双轨（#438EDB 深蓝 / #00BFF3 浅蓝）
 *   · 头占比改显式区间字段（引擎判定）
 * 本脚本在模拟器内验证上述改动真实生效（不只靠 core 单测）。
 *
 * 流程：
 *   连接 IDE → 首页 → 进 T5（规格转换，无授权）→ 点「驾驶证」芯片 →
 *   注入测试图 + mock chooseImage → 转换 → 断言输出 260×378px →
 *   回首页进 T1 → 断言底色含「标准深蓝」「浅蓝」+ 规格芯片存在 → 截图 → PASS/FAIL
 *
 * 坑（本次新增）：Picker 的候选项不在 DOM 里，无法用 page.$$ 定位 →
 *   改用页面上的「规格速览芯片」（.spec-chip）直接点选，既稳定又顺带验证了可发现性。
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
const PORT = Number(getArg('--port', 9425));
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

// 在规格芯片列表中按名称找到目标芯片并点选
async function pickSpecChip(page, name) {
  const chips = await page.$$('.spec-chip');
  for (const c of chips) {
    let t = '';
    try { t = (await c.text()) || ''; } catch (_) {}
    if (t.includes(name)) {
      await c.tap();
      await sleep(600);
      return true;
    }
  }
  return false;
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
  const results = [];
  const add = (name, ok) => {
    results.push([name, !!ok]);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  };

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

    // 0. 等首页
    let curPath;
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await miniProgram.pageStack().catch(() => []);
      curPath = (st[st.length - 1] || {}).path;
      if (curPath) break;
    }
    console.log('0) 当前页面 =', curPath || '(未就绪)');

    // ===== A. T5：规格库新数值 =====
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    add('A0 首页 5 张工具卡片', cards.length >= 5);
    try { await cards[4].tap(); }
    catch (e) { await miniProgram.navigateTo({ url: '/pages/tool-spec/index' }); }
    await sleep(3000);
    page = await miniProgram.currentPage();

    // A1. 规格速览芯片存在且共 9 项（含新增「驾驶证」）
    const chips = await page.$$('.spec-chip');
    add(`A1 规格速览芯片共 9 项（实得 ${chips.length}）`, chips.length === 9);

    // A2. 芯片含「驾驶证 260×378」与「美国签证 600×600」
    let chipTxt = [];
    for (const c of chips) { try { chipTxt.push((await c.text()) || ''); } catch (_) {} }
    const allChips = chipTxt.join(' | ');
    add('A2 芯片含「驾驶证 260×378」', allChips.includes('驾驶证 260×378'));
    add('A3 芯片含「美国签证 600×600」', allChips.includes('美国签证 600×600'));
    add('A4 芯片含「中国护照 390×567」', allChips.includes('中国护照 390×567'));

    // A5. 点选「驾驶证」芯片 → 规格区应显示驾驶证 + 官方来源
    const picked = await pickSpecChip(page, '驾驶证');
    add('A5 可点选「驾驶证」芯片', picked);
    const txtAfter = await readPageText(page);
    add('A6 选中后显示「驾驶证」', txtAfter.includes('驾驶证'));
    add('A7 选中后显示官方来源（公安部令172号）', txtAfter.includes('公安部令172号'));

    // 注入测试图
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_spec.png`;
    await miniProgram.evaluate(
      (data, p) => { wx.getFileSystemManager().writeFileSync(p, data, 'base64'); },
      b64,
      target,
    );
    await miniProgram.mockWxMethod('chooseImage', {
      tempFilePaths: [target],
      tempFiles: [{ path: target, size: b64.length }],
    });
    console.log('已注入图片 + mock chooseImage');

    // 执行转换
    const btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary');
    await btn.tap();
    console.log('已点击「选择照片并转换」，等待处理…');

    let msg = '';
    let finished = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const txt = await readPageText(page);
      if (txt) msg = txt;
      if (txt.includes('完成') || txt.includes('注意') || txt.includes('失败')) { finished = true; break; }
    }
    await shot('08-spec.png');

    // A8. 导出像素应为 260×378（驾驶证官方）
    add('A8 导出像素 260×378（驾驶证官方口径）', msg.includes('260×378'));
    add('A9 转换链路完成且无失败文案', finished && !msg.includes('失败'));

    // ===== B. T1：底色双轨 + 规格芯片 =====
    await miniProgram.navigateBack().catch(() => {});
    await sleep(2000);
    const homePage = await miniProgram.currentPage();
    const homeCards = await homePage.$$('.tool-card');
    try { await homeCards[0].tap(); }
    catch (e) { await miniProgram.navigateTo({ url: '/pages/tool-idphoto/index' }); }
    await sleep(3000);
    const p1 = await miniProgram.currentPage();
    const txtT1 = await readPageText(p1);
    add('B1 T1 底色含「标准深蓝」(#438EDB)', txtT1.includes('标准深蓝'));
    add('B2 T1 底色含「浅蓝」(#00BFF3)', txtT1.includes('浅蓝'));
    add('B3 T1 规格区显示官方来源标注', /@300dpi = \d+×\d+px/.test(txtT1));
    const t1Chips = await p1.$$('.spec-chip');
    add(`B4 T1 规格芯片共 9 项（实得 ${t1Chips.length}）`, t1Chips.length === 9);

    // ===== 汇总 =====
    console.log('\n===== 规格库专项冒烟结果 =====');
    let allPass = true;
    results.forEach(([name, ok]) => { if (!ok) allPass = false; });
    console.log('运行时错误数:', errors.length);
    if (errors.length) { allPass = false; console.log('错误:\n' + errors.join('\n')); }
    if (msg) console.log('T5 页面文本:', msg.replace(/\s+/g, ' ').slice(0, 300));
    console.log('T1 页面文本:', txtT1.replace(/\s+/g, ' ').slice(0, 220));
    console.log('截图:', path.join(SHOTS, '08-spec.png'));
    console.log(allPass ? '✅ 规格库专项冒烟通过' : '❌ 规格库专项冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(allPass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
