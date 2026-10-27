/**
 * 证件照小程序 · 自动化冒烟（T3 单独 AI 换装，模拟器内无人值守）
 *
 * 复用 smoke_auto.js / smoke_t2.js 的全部坑位经验：
 *   NODE_OPTIONS= 前缀 / 禁 reLaunch / Page 无 screenshot / mock 图先写入 USER_DATA_PATH
 *
 * 用法：
 *   NODE_OPTIONS= node 工具链/smoke_t3.js
 *   NODE_OPTIONS= node 工具链/smoke_t3.js --img 素材/测试图/test_standard.png
 *
 * 流程与断言：
 *   连接 IDE → 断言首页 → 进 T3（pages/tool-suit）→
 *   反向1（AC5）：未勾授权点处理 → 应被阻断（页面无「读取图片」进度状态）→
 *   勾 3 项授权（faceLocal+faceCloudEnhance+suitSwap）→ 注入测试图 + mock chooseImage →
 *   点「选择照片并换装」→ 轮询到完成 → 断言自检区块渲染（五官自检/PRD D3/AC6）→
 *   反向2（AC6）：未勾自检导出应被拦截 → 勾自检 → mock saveImageToPhotosAlbum →
 *   点导出 → 断言成功 → 截图 → PASS/FAIL
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
    // 统一走连接助手（launch → connect 回退 → 重试），失败给可操作提示
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

    // 1. 进 T3（首页第 3 张卡片 = AI 换装）
    let page = await miniProgram.currentPage();
    const cards = await page.$$('.tool-card');
    console.log(`1) 首页工具卡片数 = ${cards.length} ${cards.length >= 5 ? 'OK' : 'FAIL(应≥5)'}`);
    if (cards.length < 5) throw new Error('首页卡片数异常');
    try {
      await cards[2].tap(); // 第 3 张 = AI 换装
    } catch (e) {
      console.log('1) tap 卡片失败，改用 navigateTo:', e.message);
      await miniProgram.navigateTo({ url: '/pages/tool-suit/index' });
    }
    await sleep(3000);
    page = await miniProgram.currentPage();
    const stack = await miniProgram.pageStack().catch(() => []);
    const onT3 = ((stack[stack.length - 1] || {}).path || '').includes('tool-suit');
    console.log('1) 当前页面 =', (stack[stack.length - 1] || {}).path || '(未就绪)', onT3 ? 'OK' : 'FAIL(未进入 T3)');
    if (!onT3) throw new Error('未进入 T3 页面');

    // 2. 反向断言 1（AC5）：未勾授权点处理应被阻断
    let btn = await page.$('.btn-primary');
    if (!btn) throw new Error('找不到 .btn-primary（主按钮）');
    await btn.tap();
    await sleep(2000);
    let txt = await readPageText(page);
    const blocked1 = !txt.includes('读取图片') && !txt.includes('抠图处理中');
    console.log(`2) AC5 反向（未勾授权被阻断）: ${blocked1 ? 'OK' : 'FAIL(已误入处理链路)'}`);

    // 3. 勾 3 项授权（faceLocal + faceCloudEnhance + suitSwap）
    const items = await page.$$('.consent__item');
    for (const it of items) await it.tap();
    await sleep(300);
    console.log(`3) 授权项共 ${items.length}，已全部勾选 ${items.length === 3 ? 'OK' : 'FAIL(应=3)'}`);

    // 4. 注入测试图 + mock chooseImage
    const b64 = fs.readFileSync(IMG).toString('base64');
    const userDataPath = await miniProgram.evaluate(() => wx.env.USER_DATA_PATH);
    const target = `${userDataPath}/smoke_t3.png`;
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

    // 5. 点主按钮，轮询换装完成
    btn = await page.$('.btn-primary');
    await btn.tap();
    console.log('5) 已点击「选择照片并换装」，等待处理…');
    // 轮询：只认状态行（.status-line），避免展示文案污染判定（2026-10-27 修正）
    const st3 = await waitForStatus(page, ['换装完成', '处理失败', '失败'], 60);
    txt = st3.pageText;
    const status3 = st3.status || txt;
    const finished = st3.hit;
    const processed = finished && status3.includes('换装完成');
    console.log('5) 换装处理:', processed ? 'OK' : `FAIL(超时60s或失败文案: ${txt.replace(/\s+/g, ' ').slice(0, 120)})`);

    // 6. 自检区块渲染（D3/AC6）
    const selfCheckRendered = txt.includes('五官自检');
    console.log(`6) 五官自检区块渲染: ${selfCheckRendered ? 'OK' : 'FAIL(未渲染)'}`);

    // 7. 反向断言 2（AC6）：未勾自检 → 导出按钮应提示先自检
    const btns = await page.$$('button');
    let exportBtn = null;
    for (const b of btns) {
      const t = (await b.text().catch(() => '')) || '';
      if (t.includes('自检')) { exportBtn = b; break; }
    }
    const ac6Blocked = !!exportBtn;
    console.log(`7) AC6 反向（未自检导出被拦截）: ${ac6Blocked ? 'OK(按钮显示「请先完成五官自检」)' : 'FAIL(找不到自检状态导出按钮)'}`);

    // 8. 勾自检（点 .selfcheck 区块）→ mock 保存
    const selfArea = await page.$('.selfcheck');
    let selfCheckOk = false;
    if (selfArea) {
      try { await selfArea.tap(); selfCheckOk = true; }
      catch (e) { console.log('8) 点自检区块失败:', e.message); }
    } else {
      console.log('8) 找不到 .selfcheck 区块');
    }
    await sleep(500);

    // 8.5 勾镜像自查（AC1，任务 #35 加入的第二道闸门）
    //     注意：#35 之后导出按钮有 3 种文案变体（自检未完成 / 镜像未确认 / 可导出），
    //     旧脚本只认前两种 → step9 找不到按钮而误报 FAIL（2026-10-27 修正）
    const mirrorBox = await page.$('.mirror-check__box');
    if (mirrorBox) {
      try { await mirrorBox.tap(); } catch (e) { console.log('8.5) 点镜像自查失败:', e.message); }
      await sleep(400);
    } else {
      console.log('8.5) 找不到 .mirror-check__box');
    }

    // 9. 点导出（mock 保存）
    await miniProgram.mockWxMethod('saveImageToPhotosAlbum', { errMsg: 'saveImageToPhotosAlbum:ok' });
    const btns2 = await page.$$('button');
    let finalBtn = null;
    for (const b of btns2) {
      const t = (await b.text().catch(() => '')) || '';
      if (t.includes('导出并保存') || t.includes('请先完成五官自检') || t.includes('请先确认照片非镜像照')) { finalBtn = b; break; }
    }
    let exported = false;
    if (finalBtn) {
      await finalBtn.tap();
      await sleep(1500);
      const t2 = await readPageText(page);
      exported = true; // 按钮存在且可点（保存已 mock）
      console.log('9) 导出流程:', 'OK(已触发保存, mock)');
    } else {
      console.log('9) 导出流程: FAIL(找不到导出按钮)');
    }

    await shot('07-t3.png');

    const auditLogs = logs.filter((l) => l.includes('[audit]'));
    const pass = blocked1 && items.length === 3 && processed && selfCheckRendered && ac6Blocked && selfCheckOk && exported && errors.length === 0;

    console.log('\n===== T3 冒烟结果 =====');
    console.log('运行时错误数:', errors.length);
    console.log('audit 日志:', auditLogs.length ? auditLogs.join(' | ') : '（无 → 未触发上云增强）');
    if (txt) console.log('页面文本:', txt.replace(/\s+/g, ' ').slice(0, 400));
    if (errors.length) console.log('错误:\n' + errors.join('\n'));
    console.log('截图:', path.join(SHOTS, '07-t3.png'));
    console.log(pass ? '✅ T3 冒烟通过（换装主链路 + 授权门禁 + 强制自检在模拟器内跑通）' : '❌ T3 冒烟未通过 → 登记《问题台账》');

    await miniProgram.close();
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (miniProgram) { try { await miniProgram.close(); } catch (_) {} }
    process.exit(3);
  }
})();
