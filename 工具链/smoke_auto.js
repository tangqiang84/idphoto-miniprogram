'use strict';
// RC-05保留入口名称，执行逐步UI验收；旧自动跑到底脚本存为smoke_auto_legacy.js。
const crypto = require('crypto');
const { main } = require('./smoke_t1_steps');
main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ code: 'T1_UI_SETUP', message: '参数或环境不可用，请检查逐步验收说明', traceId: crypto.randomUUID() }));
  process.exitCode = 2;
});
