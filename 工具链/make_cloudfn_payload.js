#!/usr/bin/env node
'use strict';
// ===================== 云函数 matting · 云端测试载荷生成器 =====================
//
// 用途：微信云开发控制台 → 云函数 matting →「云端测试」需要手工粘贴 JSON，
//       其中 image 必须是**真实 RGBA 像素的 base64**。手工填 "<RGBA base64>" 之类的占位符
//       会让云函数读到越界数据 → alpha 全 0 且不报错（台账 #50），排查成本极高。
//       本脚本把一张 PNG 转成合规载荷，并直接复制到剪贴板，粘贴即可测试。
//
// 用法：
//   cd /Users/tq/WorkBuddy/XiaoChengXu/idphoto-miniprogram
//   NODE_OPTIONS= node ../工具链/make_cloudfn_payload.js                       # 默认真人照 40 万像素内
//   NODE_OPTIONS= node ../工具链/make_cloudfn_payload.js ../素材/测试图/test_standard.png
//   NODE_OPTIONS= node ../工具链/make_cloudfn_payload.js ../素材/测试图/test_real.png 200000
//
// 可选环境变量：
//   PAYLOAD_OUT=<路径>   输出 JSON 路径，默认 ../工具链/cloudfn-payload.json
//   NO_CLIPBOARD=1       不尝试写剪贴板
//
// 输出：终端打印尺寸/字节数/base64 长度；JSON 落盘；macOS 自动 `pbcopy`（非 macOS 跳过）。
//
// 注意：
//   1. 【硬闸门·台账 #53】云开发控制台「云端测试」走腾讯云 OpenAPI **旧签名**方式，走不通就报
//      `AuthFailure.SignatureFailure ... exceeding request size limit, please use new signature method TC3-HMAC-SHA256`
//      —— 这是**控制台网关/插件**拦的，请求根本没到云函数，改代码没用，只能缩小载荷。
//      **实测数据（2026-10-24）**：156KB ✅ 通过 / 864KB ❌ 失败 → 真实阈值在两者之间，
//      明显低于官方文档的「1MB」口径（文档写的是通用 API 上限，控制台插件另有更严限制）。
//      故本脚本默认按 **128KB** 预算生成（已实证安全区），落盘前还有出口断言。
//      想自行试探上限用环境变量覆盖：`CONSOLE_LIMIT_KB=512 node make_cloudfn_payload.js`。
//   2. 每像素约占 5.334 个 JSON 字符（RGBA 4 字节 → base64）。128KB 预算 ≈ 2.3 万像素 ≈ 133×177。
//      **结论：控制台只用来验证「路由/出图是否正常」；抠图质量验证改走小程序端 `callFunction`（5MB）
//      或本地 `工具链/baidu_live.js`（全分辨率），别在控制台上追求大图。**
//   3. 云函数运行时 `callFunction` 上限 5MB，前端 mattingCloud.js 另有 64 万像素封顶，比控制台宽得多。
//   4. 缩小用的是 baiduSeg.js 已导出的 downsampleRGBA（面积平均），不重复造轮子。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = path.resolve(__dirname, '..', 'idphoto-miniprogram');
const CF = path.join(APP, 'cloudfunctions', 'matting');
const { decodePNG } = require(path.join(CF, 'png'));
const { downsampleRGBA } = require(path.join(CF, 'baiduSeg'));

// ---- 台账 #53：控制台请求体预算（旧签名上限 1MB，留 ~10% 余量）----
// 默认 128KB：实测 156KB 通过、864KB 失败（台账 #53），取已实证安全值。
// 官方口径「旧签名 1MB」是通用 API 上限，云开发控制台插件实测更严——别按文档设预算。
const CONSOLE_LIMIT_BYTES = Number(process.env.CONSOLE_LIMIT_KB || 128) * 1024;
const JSON_OVERHEAD = 200; // consent/region/width/height 及 JSON 括号引号等固定开销
// 安全余量：downsampleRGBA 会把目标像素数向上取整到整数宽高（如 172762 → 360×480 = 172800），
// 不留余量会正好顶穿 1MB 上限（实测踩过一次）。
const SAFETY = 0.96;

/** 每像素在 JSON 里占的字符数：RGBA 4 字节 → base64 后 4/3×4 ≈ 5.334 */
const CHARS_PER_PIXEL = (4 / 3) * 4;
function maxPixelsForBudget() {
  return Math.max(1, Math.floor((CONSOLE_LIMIT_BYTES * SAFETY - JSON_OVERHEAD) / CHARS_PER_PIXEL));
}

const DEFAULT_IMG = path.resolve(__dirname, '..', '素材', '测试图', 'test_real.png');
const DEFAULT_MAX_PIXELS = maxPixelsForBudget();

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

function main() {
  const imgPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_IMG;
  const budget = maxPixelsForBudget();
  const want = Number(process.argv[3] || DEFAULT_MAX_PIXELS);
  if (!fs.existsSync(imgPath)) die('找不到图片：' + imgPath);
  if (!(want > 0)) die('maxPixels 必须为正数：' + process.argv[3]);
  let maxPixels = want;
  if (maxPixels > budget) {
    console.log(`⚠️  请求 ${maxPixels} 像素 → 约 ${((maxPixels * CHARS_PER_PIXEL) / 1024).toFixed(0)}KB JSON，`);
    console.log(`    超过云开发控制台「云端测试」1MB 请求体上限（旧签名方法，台账 #53）→ 自动收敛到 ${budget} 像素。`);
    maxPixels = budget;
  }

  let src;
  try {
    src = decodePNG(fs.readFileSync(imgPath));
  } catch (e) {
    die('解码失败（本脚本只支持 PNG）：' + (e && e.message));
  }

  let w = src.width, h = src.height;
  let px = src.data;
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    const dw = Math.max(1, Math.round(w * k));
    const dh = Math.max(1, Math.round(h * k));
    px = downsampleRGBA(px, w, h, dw, dh);
    w = dw; h = dh;
  }

  const bytes = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
  const payload = {
    consent: 'faceCloudEnhance',
    region: 'CN',
    image: bytes.toString('base64'),
    width: w,
    height: h,
  };
  const json = JSON.stringify(payload);

  // ---- 台账 #53 出口断言：宁可不生成，也不产出粘贴上去必然失败的载荷 ----
  const jsonBytes = Buffer.byteLength(json, 'utf8');
  if (jsonBytes > CONSOLE_LIMIT_BYTES) {
    die(
      `载荷 ${(jsonBytes / 1024).toFixed(0)}KB 超过 1MB 控制台上限（台账 #53），已拒绝生成。\n` +
      `   请降低像素数，最大约 ${budget} 像素；例：\n` +
      `   NODE_OPTIONS= node ../工具链/make_cloudfn_payload.js <图> ${budget}`,
    );
  }

  const out = process.env.PAYLOAD_OUT || path.resolve(__dirname, 'cloudfn-payload.json');
  fs.writeFileSync(out, json);

  console.log('✅ 载荷已生成（控制台预算内）');
  console.log('   源图：' + path.basename(imgPath) + ` ${src.width}×${src.height}` + (w !== src.width ? ` → 缩至 ${w}×${h}` : ''));
  console.log('   RGBA 字节 ' + bytes.length + '（应为 w×h×4 = ' + w * h * 4 + '）');
  console.log(
    '   JSON 落盘：' + out + '（' + (jsonBytes / 1024).toFixed(0) + 'KB / 上限 ' +
      (CONSOLE_LIMIT_BYTES / 1024).toFixed(0) + 'KB，余量 ' +
      (((CONSOLE_LIMIT_BYTES - jsonBytes) / CONSOLE_LIMIT_BYTES) * 100).toFixed(0) + '%）',
  );

  if (!process.env.NO_CLIPBOARD) {
    const r = spawnSync('pbcopy', [], { input: json });
    if (r.error || r.status !== 0) console.log('   ⚠️ 剪贴板写入失败（非 macOS 或 pbcopy 不可用），请手工打开上面的 JSON 文件复制');
    else console.log('   📋 已复制到剪贴板 → 直接粘贴进「云端测试」输入框');
  }

  console.log('\n提示：正常应返回 provider="baidu"；若 provider="shadow"，看 providerMeta.reason 定位原因。');
}

main();
