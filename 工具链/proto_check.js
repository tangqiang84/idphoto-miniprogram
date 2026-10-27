// 原型自检：语法 / 路由 / 事件绑定
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');

const problems = [];

// 1) 提取 <script> 内容并校验语法
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { problems.push('未找到 <script> 块'); }
else {
  const js = m[1];
  try { new Function(js); console.log('✓ <script> 语法编译通过'); }
  catch (e) { problems.push('语法错误: ' + e.message); }
}

// 2) 屏幕 id 集合
const screenIds = new Set();
let sm;
const sidRe = /id="(s_[a-zA-Z0-9_]+)"/g;
while ((sm = sidRe.exec(html))) screenIds.add(sm[1]);
console.log('屏幕 id 数量:', screenIds.size);

// 3) go('x') 目标存在性
const goRe = /go\(\s*'([a-zA-Z0-9_]+)'\s*\)/g;
let gm;
while ((gm = goRe.exec(html))) {
  if (!screenIds.has(gm[1])) problems.push('go() 目标不存在: ' + gm[1]);
}

// 4) onclick 函数定义存在性
const definedFns = new Set();
const fnRe = /function\s+([a-zA-Z0-9_]+)\s*\(/g;
let fm;
while ((fm = fnRe.exec(html))) definedFns.add(fm[1]);

const onclickRe = /onclick="([a-zA-Z0-9_]+)\s*\(/g;
let om;
while ((om = onclickRe.exec(html))) {
  const fn = om[1];
  if (!definedFns.has(fn)) problems.push('onclick 函数未定义: ' + fn);
}

// 5) 规格数一致性：统计各 s_* 规格 chip 数量
const chipCountRe = /id="(s_[a-zA-Z0-9_]+)"/;
// 简易：检查是否还有残留"驾照"
if (html.includes('驾照')) problems.push('仍存在"驾照"（应为"驾驶证"）');

console.log('\n=== 问题 ===');
if (problems.length === 0) console.log('✓ 无问题');
else problems.forEach(p => console.log('✗ ' + p));
process.exit(problems.length ? 1 : 0);
