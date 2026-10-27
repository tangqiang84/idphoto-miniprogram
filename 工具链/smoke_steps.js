'use strict';
/**
 * 管线流程一致性冒烟（P1 任务 #77 · 对应《测试用例与验收清单》RC-1~RC-9 的可自动判定项）
 *
 * 断言：
 *   RC-1  T1/T2/T3 均存在美颜步骤（.step-beauty），且排在裁剪之后、抠图换底之前
 *   RC-3  T1/T2/T3/T5 的输出档位是**独立步骤屏**（.step-dpi），不是内嵌在规格页里
 *   RC-5  T2 步骤序列 = 裁剪→美颜→抠图换底→预审→dpi→导出（无换装）
 *   RC-6  T3 步骤序列 = 同 T1 + 换装（必选）
 *   RC-7  T4 未勾授权时上传入口不可点（协议闸门前移）
 *   RC-8  T5 步骤序列 = 选规格→裁剪→dpi→导出（无美颜/换底/换装/预审）
 *   RC-9  各工具步骤顺序固定，无私自调整
 *
 * 用法： NODE_OPTIONS= node 工具链/smoke_steps.js [--port 9436]
 * 注意：IDE 自动化通道一次只能维持一个会话（问题 #86）→ 本脚本**一次 launch 内串行走完所有页面**。
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
const PORT = Number(getArg('--port', 9436));

const { connectAutomator } = require('./automator_connect');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : ''));
};

// 期望步骤序列（按页面显示顺序）
const SEQ = {
  t1: ['裁剪', '美颜', '抠图换底', '换装(可选)', '合规预审', '输出档位', '导出'],
  t2: ['裁剪', '美颜', '抠图换底', '合规预审', '输出档位', '导出'],
  t3: ['裁剪', '美颜', '抠图换底', '换装', '合规预审', '输出档位', '导出'],
  t5: ['选规格', '裁剪', '输出档位', '导出'],
};

async function readStepLabels(page) {
  const items = await page.$$('.step-flow__item');
  const labels = [];
  for (const it of items) {
    const t = (await it.text().catch(() => '')) || '';
    // 步骤项文本含序号前缀（如「1裁剪」）→ 断言只比标签
    labels.push(t.trim().replace(/^\d+/, ''));
  }
  return labels;
}

async function has(page, sel) {
  const els = await page.$$(sel);
  return els.length > 0;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const logs = [];
  const errors = [];
  let mp = null;
  try {
    mp = await connectAutomator({ projectPath: APP, port: PORT, timeout: 60000 });
    mp.on('console', (msg) => {
      const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
      logs.push(t);
      if (msg.type === 'error') errors.push(t);
    });

    // 等首页就绪
    let cur = '';
    for (let i = 0; i < 6; i++) {
      await sleep(3000);
      const st = await mp.pageStack().catch(() => []);
      cur = (st[st.length - 1] || {}).path || '';
      if (cur) break;
    }
    console.log('0) 当前页面 =', cur || '(未就绪)');

    const page = async () => {
      await sleep(2500);
      return mp.currentPage();
    };
    const gotoCard = async (idx) => {
      const home = await mp.currentPage();
      const cards = await home.$$('.tool-card');
      await cards[idx].tap();
      await sleep(2500);
      return mp.currentPage();
    };
    const backHome = async () => {
      try { await mp.navigateBack(); } catch (e) { /* 栈空时忽略 */ }
      await sleep(2000);
    };

    // ---- T1 ----
    let p = await gotoCard(0);
    check('T1 进入', (await mp.pageStack().catch(() => [])).some((x) => (x.path || '').includes('tool-idphoto')));
    let labels = await readStepLabels(p);
    check('RC-9/RC-5 T1 步骤顺序固定', labels.join('|') === SEQ.t1.join('|'), labels.join('|'));
    check('RC-1 T1 存在美颜步骤屏', await has(p, '.step-beauty'));
    check('RC-1 T1 存在裁剪步骤屏', await has(p, '.step-crop'));
    check('RC-3 T1 存在独立输出档位步骤屏', await has(p, '.step-dpi'));
    await mp.screenshot({ path: path.join(SHOTS, '10-t1-steps.png') }).catch(() => {});
    await backHome();

    // ---- T2 ----
    p = await gotoCard(1);
    labels = await readStepLabels(p);
    check('RC-5 T2 步骤顺序（无换装）', labels.join('|') === SEQ.t2.join('|'), labels.join('|'));
    check('RC-1 T2 存在美颜步骤屏', await has(p, '.step-beauty'));
    check('RC-3 T2 存在独立输出档位步骤屏', await has(p, '.step-dpi'));
    await mp.screenshot({ path: path.join(SHOTS, '11-t2-steps.png') }).catch(() => {});
    await backHome();

    // ---- T3 ----
    p = await gotoCard(2);
    labels = await readStepLabels(p);
    check('RC-6 T3 步骤顺序（换装必选）', labels.join('|') === SEQ.t3.join('|'), labels.join('|'));
    check('RC-1 T3 存在美颜步骤屏', await has(p, '.step-beauty'));
    check('RC-3 T3 存在独立输出档位步骤屏', await has(p, '.step-dpi'));
    await mp.screenshot({ path: path.join(SHOTS, '12-t3-steps.png') }).catch(() => {});
    await backHome();

    // ---- T4：协议闸门（RC-7）----
    p = await gotoCard(3);
    const btn = await p.$('.btn-primary');
    const disabled = btn ? await btn.attribute('disabled') : null;
    check('RC-7 T4 未勾授权时上传入口不可点', disabled !== null && disabled !== false, 'disabled=' + disabled);
    await mp.screenshot({ path: path.join(SHOTS, '13-t4-gate.png') }).catch(() => {});
    await backHome();

    // ---- T5 ----
    p = await gotoCard(4);
    labels = await readStepLabels(p);
    check('RC-8 T5 步骤顺序（纯变换）', labels.join('|') === SEQ.t5.join('|'), labels.join('|'));
    check('RC-3 T5 存在独立输出档位步骤屏', await has(p, '.step-dpi'));
    check('RC-8 T5 不存在美颜步骤屏', !(await has(p, '.step-beauty')));
    await mp.screenshot({ path: path.join(SHOTS, '14-t5-steps.png') }).catch(() => {});

    console.log('\n===== 步骤一致性冒烟结果 =====');
    console.log('运行时错误数:', errors.length);
    if (errors.length) console.log(errors.join('\n'));
    console.log(fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`);
    await mp.disconnect().catch(() => {});
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('运行失败:', e && e.message ? e.message : e);
    if (mp) { try { await mp.disconnect(); } catch (_) {} }
    process.exit(3);
  }
})();
