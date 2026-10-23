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
//   1. 像素越多 base64 越长，粘贴越慢；40 万像素 ≈ 2.1MB 字符，够用且可控。
//   2. 云函数 callFunction 上限 5MB，前端 mattingCloud.js 另有 64 万像素封顶，本脚本默认在其之下。
//   3. 缩小用的是 baiduSeg.js 已导出的 downsampleRGBA（面积平均），不重复造轮子。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = path.resolve(__dirname, '..', 'idphoto-miniprogram');
const CF = path.join(APP, 'cloudfunctions', 'matting');
const { decodePNG } = require(path.join(CF, 'png'));
const { downsampleRGBA } = require(path.join(CF, 'baiduSeg'));

const DEFAULT_IMG = path.resolve(__dirname, '..', '素材', '测试图', 'test_real.png');
const DEFAULT_MAX_PIXELS = 400000;

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

function main() {
  const imgPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_IMG;
  const maxPixels = Number(process.argv[3] || DEFAULT_MAX_PIXELS);
  if (!fs.existsSync(imgPath)) die('找不到图片：' + imgPath);
  if (!(maxPixels > 0)) die('maxPixels 必须为正数：' + maxPixels);

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

  const out = process.env.PAYLOAD_OUT || path.resolve(__dirname, 'cloudfn-payload.json');
  fs.writeFileSync(out, json);

  console.log('✅ 载荷已生成');
  console.log('   源图：' + path.basename(imgPath) + ` ${src.width}×${src.height}` + (w !== src.width ? ` → 缩至 ${w}×${h}` : ''));
  console.log('   RGBA 字节 ' + bytes.length + '（应为 w×h×4 = ' + w * h * 4 + '）');
  console.log('   JSON 落盘：' + out + '（' + (json.length / 1024).toFixed(0) + 'KB）');

  if (!process.env.NO_CLIPBOARD) {
    const r = spawnSync('pbcopy', [], { input: json });
    if (r.error || r.status !== 0) console.log('   ⚠️ 剪贴板写入失败（非 macOS 或 pbcopy 不可用），请手工打开上面的 JSON 文件复制');
    else console.log('   📋 已复制到剪贴板 → 直接粘贴进「云端测试」输入框');
  }

  console.log('\n提示：正常应返回 provider="baidu"；若 provider="shadow"，看 providerMeta.reason 定位原因。');
}

main();
