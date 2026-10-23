/**
 * 诊断工具：验证 miniprogram-automator 与微信开发者工具的连接是否可用
 * 用法： NODE_OPTIONS= node 工具链/diag_automator.js
 * 前置：开发者工具已开启「设置 → 安全设置 → 服务端口」（默认 9420）
 * 用途：当 smoke_auto.js 报 automator 内部错误（如 getPageMetaByWebviewId null）时先跑这个定位
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'idphoto-miniprogram');
const MOD = '/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const automator = require(MOD);
  console.log('automator 版本:', require(path.join(MOD, 'package.json')).version);
  console.log('项目路径:', APP);

  const mp = await automator.launch({ projectPath: APP, port: 9420, timeout: 60000 });
  console.log('launch OK');
  await sleep(6000); // 等编译与首页渲染

  try {
    const p = await mp.currentPage();
    console.log('currentPage OK');
    console.log('Page 可用方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(p) || {}).join(','));
    console.log('MiniProgram 可用方法:', Object.getOwnPropertyNames(Object.getPrototypeOf(mp) || {}).join(','));
    try {
      console.log('p.path =', p.path, '| p.data =', JSON.stringify(p.data || {}).slice(0, 120));
    } catch (e) { console.log('读 path/data 失败:', e.message); }
    try {
      const ps = await mp.pageStack();
      console.log('pageStack =', JSON.stringify(ps).slice(0, 200));
    } catch (e) { console.log('pageStack 失败:', e.message); }
    try {
      const els = await p.$$('view');
      console.log('view 元素数 =', els.length);
      const cards = await p.$$('.tool-card');
      console.log('tool-card 数 =', cards.length);
    } catch (e) { console.log('选择器阶段 ERR:', e.message); }
    try {
      await p.screenshot({ path: path.join(ROOT, '素材/测试截图/diag.png') });
      console.log('截图 OK');
    } catch (e) { console.log('截图失败:', e.message); }
  } catch (e) {
    console.log('页面操作阶段 ERR:', e && e.message);
  }

  await mp.close();
  console.log('诊断结束');
})().catch((e) => {
  console.log('FATAL:', e && e.message);
  process.exit(1);
});
