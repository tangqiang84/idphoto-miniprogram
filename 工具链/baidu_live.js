#!/usr/bin/env node
'use strict';
// ===================== 百度人像分割 · 真实联调脚本 =====================
//
// 用途：拿到百度智能云的 API Key / Secret Key 后，用**真实请求**验证
//       cloudfunctions/matting/baiduSeg.js 的链路是否真的跑得通（单测是 mock，本脚本才是真）。
//
// 用法（凭据只走环境变量，绝不落盘、绝不入库）：
//   cd /Users/tq/WorkBuddy/XiaoChengXu/idphoto-miniprogram
//   BAIDU_API_KEY=你的APIKey BAIDU_SECRET_KEY=你的SecretKey \
//     node ../工具链/baidu_live.js                         # 默认用素材/测试图/test_standard.png
//   BAIDU_API_KEY=... BAIDU_SECRET_KEY=... node ../工具链/baidu_live.js ../素材/测试图/test_complex.png
//
// （脚本内部按自身位置定位工程与素材，因此必须在 idphoto-miniprogram 目录下执行；
//   传入的图片路径相对 idphoto-miniprogram 解析）
//
// 可选环境变量：
//   BAIDU_LIVE_TOKEN_ONLY=1   只验证 access_token 能否换取（不花调用量）
//   BAIDU_LIVE_OUT=<路径>     结果图输出路径，默认 素材/测试截图/baidu-live-<时间戳>.png
//
// 输出：token 前 6 位（不明文打印完整 token）、HTTP 往返耗时、返回字段、
//       alpha 统计（前景占比/歧义占比）、合成图（左：原图 右：白底抠图 右二：透明底）。
//
// 注意：
//   1. 每次运行消耗 1 次调用额度（个人免费 1 万次）。只验 token 时加 BAIDU_LIVE_TOKEN_ONLY=1。
//   2. 出现 error_code 110 = 应用未开通「人像分割」权限，去控制台开通后重试。
//   3. 出现 216202 = 图片超限，脚本已内置降采样，若仍报请换小图。

const path = require('node:path');
const fs = require('node:fs');

const APP = path.resolve(__dirname, '..', 'idphoto-miniprogram');
const CF = path.join(APP, 'cloudfunctions', 'matting');
const { encodePNG, decodePNG } = require(path.join(CF, 'png'));
const baidu = require(path.join(CF, 'baiduSeg'));

const API_KEY = (process.env.BAIDU_API_KEY || '').trim();
const SECRET_KEY = (process.env.BAIDU_SECRET_KEY || '').trim();
const TOKEN_ONLY = String(process.env.BAIDU_LIVE_TOKEN_ONLY || '') === '1';

function die(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

async function main() {
  if (!API_KEY || !SECRET_KEY) {
    die('缺少凭据。用法：BAIDU_API_KEY=xxx BAIDU_SECRET_KEY=xxx node 工具链/baidu_live.js\n' +
      '（凭据只走环境变量，不要写进任何文件；云函数运行时同理读 BAIDU_API_KEY / BAIDU_SECRET_KEY）');
  }

  const client = baidu.makeBaiduSegClient({ apiKey: API_KEY, secretKey: SECRET_KEY });

  // ---------- ① 只验 token ----------
  const t0 = Date.now();
  let token;
  try {
    token = await client.getToken();
  } catch (e) {
    die('换取 access_token 失败：' + (e && e.message) + '\n  常见原因：API Key/Secret Key 填错、应用被禁用、网络不通');
  }
  console.log('✅ access_token 获取成功：' + String(token).slice(0, 6) + '…（' + (Date.now() - t0) + 'ms，有效期 ' +
    Math.round((client.tokenCache.expiresAt - Date.now()) / 86400000) + ' 天）');
  if (TOKEN_ONLY) {
    console.log('（BAIDU_LIVE_TOKEN_ONLY=1，已跳过图像调用，不消耗额度）');
    return;
  }

  // ---------- ② 读测试图 ----------
  const rel = process.argv[2] || '../素材/测试图/test_standard.png';
  const imgPath = path.resolve(APP, rel);
  if (!fs.existsSync(imgPath)) die('找不到测试图：' + imgPath);
  let src;
  try {
    src = decodePNG(fs.readFileSync(imgPath));
  } catch (e) {
    die('解码测试图失败（脚本只支持 PNG）：' + (e && e.message));
  }
  const w = src.width, h = src.height;
  console.log(`🖼  输入：${path.basename(imgPath)} ${w}×${h}`);

  // ---------- ③ 真实调用 ----------
  let r;
  try {
    r = await client.segment(src.data, w, h);
  } catch (e) {
    const code = e && e.code;
    console.error('❌ 人像分割调用失败：' + (e && e.message));
    if (code === 110) console.error('   → 处置：百度智能云控制台 → 已开通服务里确认「人像分割」已开通，且应用的接口权限已勾选');
    else if (code === 18) console.error('   → 处置：QPS 超限（个人默认 2QPS），稍后重试或购买并发');
    else if (code === 17 || code === 19) console.error('   → 处置：免费额度已用完，需购买或等次日');
    else if (code === 216202) console.error('   → 处置：图片超限，换更小的图');
    process.exit(2);
  }

  // ---------- ④ 结果统计 ----------
  let fg = 0, amb = 0, sum = 0;
  for (let i = 0; i < r.alpha.length; i++) {
    const a = r.alpha[i];
    sum += a;
    if (a >= 0.5) fg++;
    else if (a > 0.1 && a < 0.9) amb++;
  }
  const n = r.alpha.length;
  console.log('✅ 人像分割调用成功');
  console.log('   来源字段 source = ' + r.meta.source + '（scoremap=软 alpha 灰度图，foreground=透明前景 PNG）');
  console.log('   检测到人体数 person_num = ' + r.meta.personNum);
  console.log('   上传像素 ' + r.meta.uploadPixels + '（是否降采样：' + r.meta.downscaled + '），urlencode 后 body ' + r.meta.uploadBytes + ' 字节');
  console.log('   接口耗时 ' + r.meta.latencyMs + 'ms');
  console.log('   前景占比 ' + (fg / n * 100).toFixed(1) + '% ，半透明边缘占比 ' + (amb / n * 100).toFixed(1) + '% ，alpha 均值 ' + (sum / n).toFixed(3));

  // ---------- ⑤ 出对比图（原图 / 白底 / 透明底） ----------
  const out = process.env.BAIDU_LIVE_OUT ||
    path.resolve(__dirname, '..', '素材', '测试截图', 'baidu-live-' + Date.now() + '.png');
  const W = w * 3, H = h;
  const canvas = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const a = r.alpha[i];
    const put = (ox, r0, g0, b0, a0) => {
      const j = (y * W + ox) * 4;
      canvas[j] = r0; canvas[j + 1] = g0; canvas[j + 2] = b0; canvas[j + 3] = a0;
    };
    // 左：原图
    put(x, src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2], 255);
    // 中：白底合成
    put(w + x, src.data[i * 4] * a + 255 * (1 - a), src.data[i * 4 + 1] * a + 255 * (1 - a), src.data[i * 4 + 2] * a + 255 * (1 - a), 255);
    // 右：透明底（红蓝棋盘便于肉眼判断边缘）
    const chk = (((x >> 4) + (y >> 4)) & 1) ? [255, 0, 0] : [0, 0, 255];
    put(w * 2 + x, src.data[i * 4] * a + chk[0] * (1 - a), src.data[i * 4 + 1] * a + chk[1] * (1 - a), src.data[i * 4 + 2] * a + chk[2] * (1 - a), 255);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(canvas, W, H));
  console.log('🖼  对比图已输出：' + out + '（左=原图，中=白底，右=透明底棋盘）');
}

main().catch((e) => die(String((e && e.stack) || e)));
