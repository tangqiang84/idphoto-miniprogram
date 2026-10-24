#!/usr/bin/env node
'use strict';
// ===================== 云函数 matting 返回结果 · 解码与可视化判读 =====================
//
// 用途：云开发控制台「云端测试」返回的 alphaB64 是一长串字符，肉眼无法判读质量。
//       本脚本把它解回 alpha 通道，与**发送的同一张源图**合成三联对比图（原图 / 白底 / 透明底），
//       并打印关键判读指标（provider / 前景占比 / 半透明边缘占比 / 唯一值个数），
//       顺带对「退化结果」给出明确结论，避免"看起来出图了其实抠坏了"。
//
// 用法（必须在 idphoto-miniprogram 目录下执行）：
//   cd /Users/tq/WorkBuddy/XiaoChengXu/idphoto-miniprogram
//   NODE_OPTIONS= node ../工具链/decode_cloudfn_result.js                          # 从剪贴板读返回结果
//   NODE_OPTIONS= node ../工具链/decode_cloudfn_result.js ../工具链/cf-result.json   # 从文件读
//   NODE_OPTIONS= node ../工具链/decode_cloudfn_result.js cf-result.json small      # 指定对应的载荷（取源图）
//
// 入参：
//   <result>   返回结果的 JSON 文本。支持三种形态：
//              · 完整返回对象 {"alphaB64":"...","provider":"baidu",...}
//              · 只有 alphaB64 的对象/裸字符串
//              · 控制台外层包了 {"result": {...}} 也认
//              不传文件时**自动读剪贴板**（pbpaste），控制台里复制完直接跑最省事。
//   <payload>  发送时用的载荷（cloudfn-payload.json / -small / -probe512），用于取源图像素与尺寸；
//              不传则用 ../工具链/cloudfn-payload.json。
//
// 输出：终端判读结论 + 三联图 素材/测试截图/cloudfn-result-<时间戳>.png
//
// 注意：
//   1. 判读口径沿用台账 #45：真模型软 alpha 的 confidence 天然更低，**不得**用「歧义占比」判优劣；
//      这里只看「前景占比是否退化」与「唯一值个数是否塌缩成常数」这两条硬指标。
//   2. 复用 cloudfunctions/matting/png.js 的 encodePNG 与 baidu_live.js 的三联合成口径，不重复造轮子。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = path.resolve(__dirname, '..', 'idphoto-miniprogram');
const CF = path.join(APP, 'cloudfunctions', 'matting');
const { encodePNG } = require(path.join(CF, 'png'));

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

/** 从文件或剪贴板拿到返回结果文本 */
function readResult(arg) {
  if (arg) {
    const p = path.resolve(APP, arg);
    if (!fs.existsSync(p)) die('找不到结果文件：' + p);
    return fs.readFileSync(p, 'utf8');
  }
  const r = spawnSync('pbpaste', [], { encoding: 'utf8' });
  if (r.error || r.status !== 0) die('未指定结果文件，且剪贴板读取失败（非 macOS？）。请传入结果 JSON 文件路径。');
  const t = String(r.stdout || '').trim();
  if (!t) die('剪贴板是空的。请先在控制台复制返回结果，或传入结果 JSON 文件路径。');
  return t;
}

/** 从各种包装形态里抠出 alphaB64 */
function extractAlpha(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // 裸 base64 字符串
    const t = text.trim().replace(/^"|"$/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(t)) return { alphaB64: t, raw: {} };
    die('结果既不是合法 JSON 也不是裸 base64，无法解析。前 200 字符：\n' + text.slice(0, 200));
  }
  if (typeof obj === 'string') return { alphaB64: obj, raw: {} };
  // 控制台可能外层包一层 {"result": ...}
  let node = obj;
  while (node && typeof node === 'object' && node.result && !node.alphaB64) node = node.result;
  if (typeof node === 'string') return { alphaB64: node, raw: obj };
  if (node && node.alphaB64) return { alphaB64: String(node.alphaB64), raw: obj };
  die('结果里找不到 alphaB64 字段。可用字段：' + Object.keys(node || {}).join(', '));
}

function main() {
  const { alphaB64, raw } = extractAlpha(readResult(process.argv[2]));

  const alpha = Buffer.from(alphaB64, 'base64');

  // ---- 源图（取发送时用的载荷，保证 RGB 与 alpha 严格对齐）----
  // 不指定载荷时**自动匹配**：遍历 工具链/cloudfn-payload*.json，挑 w×h === alpha.length 的那份。
  // （手写路径极易错配——我自己第一版就写错，故改成自动匹配 + 显式参数兜底）
  const TOOL = path.resolve(__dirname);
  const candidates = process.argv[3]
    ? [path.resolve(APP, process.argv[3])]
    : fs.readdirSync(TOOL).filter((f) => /^cloudfn-payload.*\.json$/.test(f)).map((f) => path.join(TOOL, f));
  let payload = null, payloadPath = null;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (c.width * c.height === alpha.length) { payload = c; payloadPath = p; break; }
    } catch { /* 非载荷 JSON，跳过 */ }
  }
  if (!payload) {
    die(
      `没找到与 alpha 长度（${alpha.length} 像素）匹配的载荷。已尝试：\n   ` +
      candidates.join('\n   ') + '\n' +
      `   若结果来自其他图，请先把那张图生成载荷：` +
      `node ../工具链/make_cloudfn_payload.js <图> <像素数>，再用第二个参数指定它。`,
    );
  }
  const src = Buffer.from(payload.image, 'base64');
  const w = payload.width, h = payload.height;

  // ---- 统计 ----
  let fg = 0, amb = 0, sum = 0;
  const uniq = new Set();
  for (const v of alpha) {
    sum += v;
    uniq.add(v);
    if (v >= 128) fg++;
    else if (v > 25 && v < 230) amb++;
  }
  const n = alpha.length;
  const fgRatio = fg / n;
  const ambRatio = amb / n;
  const mean = sum / n;

  console.log('📥 返回结果判读');
  console.log('   provider      = ' + (raw.provider || '(未返回)'));
  if (raw.providerMeta) console.log('   providerMeta  = ' + JSON.stringify(raw.providerMeta));
  console.log('   源图          = ' + path.basename(payloadPath) + ` ${w}×${h}（载荷 ${(fs.statSync(payloadPath).size / 1024).toFixed(0)}KB）`);
  console.log('   alpha 均值    = ' + (mean / 255).toFixed(3));
  console.log('   前景占比      = ' + (fgRatio * 100).toFixed(1) + '%');
  console.log('   半透明边缘占比 = ' + (ambRatio * 100).toFixed(1) + '%（软 alpha 的证据，不是缺陷）');
  console.log('   alpha 唯一值  = ' + uniq.size + '（个；越接近 1 越说明结果塌缩成常数）');

  // ---- 结论（硬指标，见文件头注意 1）----
  console.log('\n🧭 结论：');
  if (raw.provider === 'baidu') console.log('   ✅ 走的是百度人像分割（云端 Key 已生效，链路打通）');
  else if (raw.provider === 'shadow') console.log('   ⚠️ 走的是影子实现（百度未生效）→ 看上面 providerMeta.reason 定位：未配 Key / 尺寸越界 / 额度或 QPS');
  else console.log('   ❓ 返回里没有 provider 字段，无法判断走了哪条链路');

  if (uniq.size <= 4) console.log('   ❌ alpha 几乎是个常数 → 结果塌缩（对照台账 #52 的假逆矩阵 bug），不可用');
  else if (fgRatio < 0.005) console.log('   ❌ 前景占比 <0.5% → 退化：模型没检出人（对照台账 #49 卡通图全 0），线上会被 shouldAcceptCloudAlpha 拦下降级');
  else if (fgRatio > 0.97) console.log('   ❌ 前景占比 >97% → 几乎没分割（整张都是前景），不可用');
  else if (ambRatio < 0.001) console.log('   ⚠️ 几乎没有半透明像素 → 可能是硬边二值结果，不像百度 scoremap 软 alpha');
  else console.log('   ✅ 数值形态正常（有前景、有软边缘、非常数）→ 以三联图肉眼确认边缘质量');

  // ---- 三联图（口径与 baidu_live.js 一致：原图 / 白底 / 透明底棋盘）----
  const out = path.resolve(__dirname, '..', '素材', '测试截图', 'cloudfn-result-' + Date.now() + '.png');
  const W = w * 3, H = h;
  const canvas = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const a = alpha[i] / 255;
    const r0 = src[i * 4], g0 = src[i * 4 + 1], b0 = src[i * 4 + 2];
    const put = (ox, r1, g1, b1) => {
      const j = (y * W + ox) * 4;
      canvas[j] = r1; canvas[j + 1] = g1; canvas[j + 2] = b1; canvas[j + 3] = 255;
    };
    put(x, r0, g0, b0);
    put(w + x, r0 * a + 255 * (1 - a), g0 * a + 255 * (1 - a), b0 * a + 255 * (1 - a));
    const chk = (((x >> 4) + (y >> 4)) & 1) ? [255, 0, 0] : [0, 0, 255];
    put(w * 2 + x, r0 * a + chk[0] * (1 - a), g0 * a + chk[1] * (1 - a), b0 * a + chk[2] * (1 - a));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(canvas, W, H));
  console.log('\n🖼  三联图已输出：' + out);
  console.log('   （左=原图，中=白底合成，右=透明底棋盘——棋盘只在背景区透出才是抠对了）');
}

main();
