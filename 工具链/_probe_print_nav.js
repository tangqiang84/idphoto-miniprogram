/** 临时探针：定位 navigateTo 到 T6 失败的原因（不入库，跑完即删） */
const path = require('path');
const APP = path.join(path.resolve(__dirname, '..'), 'idphoto-miniprogram');
let automator;
try {
  automator = require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
} catch (e) {
  automator = require(path.join(APP, 'node_modules/miniprogram-automator'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const logs = [];
  const miniProgram = await automator.launch({ projectPath: APP, port: 9425, timeout: 60000 });
  miniProgram.on('console', (msg) => {
    const t = `[${msg.type}] ${msg.text || msg.message || ''}`;
    logs.push(t);
    console.log('CONSOLE:', t.slice(0, 300));
  });
  miniProgram.on('exception', (e) => console.log('EXCEPTION:', JSON.stringify(e).slice(0, 500)));
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    const st = await miniProgram.pageStack().catch(() => []);
    if ((st[st.length - 1] || {}).path) break;
  }
  console.log('--- navigateTo tool-spec（对照组）---');
  try {
    await miniProgram.navigateTo({ url: '/pages/tool-spec/index' });
    console.log('navigateTo tool-spec OK');
  } catch (e) {
    console.log('navigateTo tool-spec ERR:', e && e.message, JSON.stringify(e).slice(0, 300));
  }
  await sleep(2000);
  console.log('--- navigateTo tool-print ---');
  try {
    await miniProgram.navigateTo({ url: '/pages/tool-print/index' });
    console.log('navigateTo OK');
  } catch (e) {
    console.log('navigateTo ERR:', e && e.message, JSON.stringify(e).slice(0, 600));
  }
  await sleep(3000);
  const st = await miniProgram.pageStack().catch(() => []);
  console.log('页面栈:', st.map((p) => p.path).join(' | '));
  console.log('--- 最后 10 条 console ---');
  logs.slice(-10).forEach((l) => console.log('  ', l.slice(0, 300)));
  try { await miniProgram.close(); } catch (e) {}
})();
