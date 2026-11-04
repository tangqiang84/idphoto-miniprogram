'use strict';
// RC-03：检查真实页面控制代码的调用时机；旧组件/标签检查已保留为legacy资产。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probePage } = require('./page_flow_probe');

async function main(args = process.argv.slice(2)) {
  let tool = 'all';
  let output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node') continue;
    if (args[i] === '--tool' && args[i + 1]) tool = args[++i];
    else if (args[i] === '--out' && args[i + 1]) output = path.resolve(args[++i]);
    else if (args[i] === '--help') {
      console.log('node 工具链/smoke_steps.js --node [--tool T1|T2|T3|T5|all] [--out 新目录]');
      return 0;
    } else throw new Error('STEP_PROBE_ARGUMENT');
  }
  if (!['T1', 'T2', 'T3', 'T5', 'all'].includes(tool)) throw new Error('STEP_PROBE_ARGUMENT');
  const root = path.resolve(__dirname, '..');
  const traceId = 'step-' + crypto.randomUUID();
  const out = output || path.join(root, 'docs', '验证记录', 'step-flow', traceId);
  if (fs.existsSync(out)) throw new Error('STEP_PROBE_OUTPUT_EXISTS');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(out);
  const rows = [];
  for (const name of tool === 'all' ? ['T1', 'T2', 'T3', 'T5'] : [tool]) {
    try { rows.push(await probePage(name)); }
    catch { rows.push({ tool: name, status: 'BLOCKED', reason: '页面适配器不支持当前实现，需人工检查，不计通过' }); }
  }
  const status = rows.some((row) => row.status === 'FAIL') ? 'FAIL'
    : rows.some((row) => row.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  const report = { status, traceId, timestamp: new Date().toISOString(), runtime: process.version, scope: 'Node实际页面控制代码/平台与图像算法替身，非微信UI或真实模型验收', rows };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  for (const row of rows) console.log(`${row.status} ${row.tool}：${row.reason}`);
  console.log(JSON.stringify({ status, report: path.join(out, 'report.json'), scope: report.scope }));
  return status === 'FAIL' ? 1 : status === 'BLOCKED' ? 3 : 0;
}

module.exports = { main };
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ code: 'STEP_PROBE_ERROR', message: '参数、输出目录或检查器不可用，请检查；旧结果不会覆盖。', traceId: crypto.randomUUID() }));
  process.exitCode = 2;
});
