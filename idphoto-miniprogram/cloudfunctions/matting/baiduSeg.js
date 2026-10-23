'use strict';
// ===================== 百度智能云「人像分割」接入（商用 API） =====================
//
// 接口：POST https://aip.baidubce.com/rest/2.0/image-classify/v1/body_seg?access_token=xxx
//   Content-Type: application/x-www-form-urlencoded
//   body: image=<urlencode(base64 图片文件)>&type=scoremap
//   返回：{ log_id, scoremap, foreground, labelmap, person_num }
//
// 【为什么选 scoremap 而不是 foreground】
//   scoremap = 灰度图，每像素灰度 = 置信度×255（0~1 的软 alpha）→ 直接当 alpha，
//     发丝/半透明边缘保留最完整，与本项目「抠图后换底色」的用途最匹配。
//   foreground = 百度已按 0.5 阈值抠出并做 matting 消锯齿的透明 PNG →
//     质量也不错，但边缘已被二值化+消锯齿，半透明区域信息丢失。
//   故：主取 scoremap，foreground 仅作为**兜底**（scoremap 缺失时取 A 通道）。
//
// 【三个硬限制（写进代码，避免后人踩坑）】
//   1. base64 **再 urlencode 后 ≤4MB**。urlencode 会把 `+` `/` `=` 各膨胀成 3 字符，
//      最坏情况体积 ×3 —— 这是最容易爆的隐藏雷，故上传前先降采样并**实测 body 长度**。
//   2. 最短边 ≥15px，最长边 ≤4096px，格式 jpg/png/bmp。
//   3. 计费：个人认证免费 10000 次 / QPS 2，企业认证 50000 次 / QPS 5（365 天有效）；
//      超出后按调用量阶梯计费。故本项目**只在端侧置信不足时调用**（任务路由见 core/matting.js）。
//
// 【合规】
//   - 本文件只被**云函数**调用，API Key / Secret Key 只从环境变量读取，绝不进小程序包体。
//   - aip.baidubce.com 为百度智能云中国大陆节点 → 数据不出境成立（与 PRD 第226行一致）。
//   - 请求体只含「裁剪后人像区域」像素（由 core/mattingCloud.cropForeground 保证），不含全图。
//
// 【可测试性】
//   网络请求 / 时间 / PNG 解码全部依赖注入，单测无需联网即可覆盖 token 缓存、
//   错误码映射、降采样、alpha 提取、降级语义。

const { encodePNG, decodePNG } = require('./png');

// 境内节点常量：改动此值即视为「数据出境」，必须走合规评审（core 单测有静态断言守着）
const BAIDU_SEG_HOST = 'aip.baidubce.com';
const TOKEN_URL = 'https://' + BAIDU_SEG_HOST + '/oauth/2.0/token';
const SEG_URL = 'https://' + BAIDU_SEG_HOST + '/rest/2.0/image-classify/v1/body_seg';

// 上传像素封顶：512×512 = 262144。
// 依据：RGBA 原始像素 → PNG → base64(×1.34) → urlencode(最坏×3)，4MB 上限很容易被打穿；
// 而云端只用于「精修 alpha 边缘」，512 已远超边缘细节所需（最终会双线性放大回原尺寸）。
const DEFAULT_MAX_PIXELS = 512 * 512;
// body 字节上限取 4MB 的 95% 留余量
const DEFAULT_MAX_BODY = Math.floor(4 * 1024 * 1024 * 0.95);
// token 提前续期窗口（百度 token 有效期通常 30 天，提前 1 天续，避免边界失效）
const TOKEN_SKEW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// ===================== provider 决策（纯函数，可单测） =====================
// 未配置 Key → 走影子实现（不阻断、不报错，保证链路永远可用）
function resolveProvider({ apiKey = '', secretKey = '', enabled = true } = {}) {
  if (!enabled) return { provider: 'shadow', reason: 'BAIDU_ENABLED=false，已强制走影子实现' };
  const ak = (apiKey || '').trim();
  const sk = (secretKey || '').trim();
  if (!ak || !sk) return { provider: 'shadow', reason: '未配置 BAIDU_API_KEY / BAIDU_SECRET_KEY，走影子实现' };
  return { provider: 'baidu', reason: '' };
}

// ===================== token 有效期（纯函数） =====================
function isTokenValid({ token = '', expiresAt = 0, now = 0, skewMs = TOKEN_SKEW_MS } = {}) {
  if (!token) return false;
  return now < expiresAt - skewMs;
}

// 解析 token 响应，返回 { token, expiresAt }；失败抛错（错误含 error/error_description）
function parseTokenResponse(json, now) {
  if (!json) throw new Error('baidu.token: 响应为空');
  if (json.error) throw new Error(`baidu.token: ${json.error} ${json.error_description || ''}`.trim());
  if (!json.access_token) throw new Error('baidu.token: 响应缺少 access_token');
  const expiresIn = Number(json.expires_in) || 0;
  if (!(expiresIn > 0)) throw new Error('baidu.token: 响应缺少有效 expires_in');
  return { token: String(json.access_token), expiresAt: now + expiresIn * 1000 };
}

// ===================== 错误码映射 =====================
// 返回 { code, msg, retryable }：retryable 表示「重试可能成功」（限流/服务抖动），
// 非 retryable 表示「配置或参数问题，重试无用」——调用方据此决定是否退避。
function mapErrCode(code, msg) {
  const c = Number(code);
  const known = {
    1: ['服务器内部错误，请重试', true],
    2: ['服务暂不可用，请重试', true],
    3: ['调用的 API 不存在，检查 URL', false],
    4: ['集群超限额，请重试', true],
    6: ['无权限访问该接口', false],
    14: ['IAM 鉴权失败，检查 API Key/Secret Key', false],
    17: ['每日调用量超限，需购买或等待次日', false],
    18: ['QPS 超限（个人默认 2QPS），需购买并发或降低调用频率', true],
    19: ['请求总量超限额，需购买', false],
    100: ['无效参数', false],
    110: ['接口权限未开通：请到百度智能云控制台开通「人像分割」并给应用勾选该接口', false],
    111: ['access_token 无效或已过期', true],
    216200: ['图片为空', false],
    216201: ['图片格式错误（仅支持 jpg/png/bmp）', false],
    216202: ['图片大小超限（base64+urlencode 后 ≤4MB）', false],
    216630: ['识别错误，请换图重试', false],
  };
  const hit = known[c];
  if (hit) return { code: c, msg: hit[0] + (msg ? `（${msg}）` : ''), retryable: hit[1] };
  return { code: c || 0, msg: msg || '未知错误', retryable: false };
}

function isApiError(json) {
  return !!(json && (json.error_code !== undefined || json.error_msg !== undefined));
}

// ===================== alpha 提取 =====================
// 统一从解码后的 RGBA 里取 alpha：
//   source='scoremap'   → 灰度置信度（R 通道 = 置信度×255）
//   source='foreground' → 透明 PNG 的 A 通道
function extractAlpha(decoded, source) {
  const n = decoded.width * decoded.height;
  const out = new Float32Array(n);
  if (source === 'foreground') {
    for (let i = 0; i < n; i++) out[i] = decoded.data[i * 4 + 3] / 255;
  } else {
    for (let i = 0; i < n; i++) out[i] = decoded.data[i * 4] / 255;
  }
  return out;
}

// 解析 body_seg 响应 → { alpha, width, height, source, personNum }
// decodeImpl 注入（默认 decodePNG），便于单测直接喂 PNG buffer 或伪造解码结果
function parseSegResponse(json, { decodeImpl } = {}) {
  if (!json) throw new Error('baidu.seg: 响应为空');
  if (isApiError(json)) {
    const e = mapErrCode(json.error_code, json.error_msg);
    const err = new Error(`baidu.seg: [${e.code}] ${e.msg}`);
    err.code = e.code;
    err.retryable = e.retryable;
    throw err;
  }
  const decode = decodeImpl || ((b64) => decodePNG(Buffer.from(stripB64(b64), 'base64')));
  if (json.scoremap) {
    const d = decode(json.scoremap, 'scoremap');
    return { alpha: extractAlpha(d, 'scoremap'), width: d.width, height: d.height, source: 'scoremap', personNum: json.person_num == null ? null : json.person_num };
  }
  if (json.foreground) {
    const d = decode(json.foreground, 'foreground');
    return { alpha: extractAlpha(d, 'foreground'), width: d.width, height: d.height, source: 'foreground', personNum: json.person_num == null ? null : json.person_num };
  }
  throw new Error('baidu.seg: 响应既无 scoremap 也无 foreground');
}

// base64 里可能混入换行/空格（部分 SDK 输出习惯），必须先剔除
function stripB64(s) {
  return String(s || '').replace(/[\r\n\s]/g, '');
}

// ===================== 降采样 / 放大 =====================
// ⚠️ 与 src/core/mattingCloud.js 的 downsampleRGBA / upscaleAlpha **同算法**：
//    云函数是独立部署包（只上传 cloudfunctions/matting），无法 require src/core，故保留一份；
//    core 单测里有「两边结果一致」的断言守着，改任意一边都会红。
function downsampleRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const rx = sw / dw, ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * ry), y1 = Math.min(sh - 1, Math.ceil((y + 1) * ry) - 1);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * rx), x1 = Math.min(sw - 1, Math.ceil((x + 1) * rx) - 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const i = (yy * sw + xx) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
      }
      const di = (y * dw + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return out;
}

function upscaleAlpha(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const rx = sw / dw, ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * ry, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * rx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// ===================== 默认网络请求（Node https） =====================
// 为什么不用 fetch：CloudBase 云函数可能跑在 Node 16（无全局 fetch），https 模块最稳。
function defaultRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let mod;
    try {
      const u = new URL(url);
      mod = u.protocol === 'https:' ? require('https') : require('http');
      const req = mod.request(
        { hostname: u.hostname, path: u.pathname + u.search, method, headers: { Accept: 'application/json', ...headers } },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('baidu: 请求超时（' + timeoutMs + 'ms）')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
      return;
    }
  });
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// ===================== 客户端 =====================
// 入参：{ apiKey, secretKey, requestImpl, now, timeoutMs, maxPixels, maxBodyBytes, decodeImpl }
// 出参：{ segment(rgba,w,h) -> { alpha, provider:'baidu', meta } }
function makeBaiduSegClient(opts = {}) {
  const {
    apiKey, secretKey,
    requestImpl = defaultRequest,
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxPixels = DEFAULT_MAX_PIXELS,
    maxBodyBytes = DEFAULT_MAX_BODY,
    decodeImpl = null,
  } = opts;
  const tokenCache = { token: '', expiresAt: 0 };

  async function getToken() {
    const t = typeof now === 'function' ? now() : now;
    if (isTokenValid({ token: tokenCache.token, expiresAt: tokenCache.expiresAt, now: t })) return tokenCache.token;
    const url = `${TOKEN_URL}?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
    const res = await requestImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs });
    const json = parseJsonSafe(res.text);
    if (!json) throw new Error(`baidu.token: 响应非 JSON（HTTP ${res.status}）`);
    const parsed = parseTokenResponse(json, t);
    tokenCache.token = parsed.token;
    tokenCache.expiresAt = parsed.expiresAt;
    return parsed.token;
  }

  async function segment(rgba, width, height) {
    if (!(width > 0) || !(height > 0)) throw new Error('baidu.seg: 尺寸非法');
    const token = await getToken();

    // ① 像素封顶 → ② 编码 PNG → ③ 实测 urlencode 后 body 长度，超限继续缩（最多 3 次）
    let w = width, h = height, px = rgba;
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
      px = downsampleRGBA(rgba, w, h, dw, dh);
      w = dw; h = dh;
    }
    // 每次按面积 ×0.7 收缩；上限 8 次（再小就没有分割意义了），且边长 < MIN_EDGE 时停止。
    // 实测：真实照片在 512 封顶下几乎不会触发重试（压缩率高），此循环只是极端噪声图的兜底；
    // 若 8 次仍超限，照发不误 —— 让百度返回 216202，由调用方走降级，好过无限缩小到不可用。
    const MIN_EDGE = 48;
    let body = null, tries = 0;
    for (;;) {
      const b64 = encodePNG(px, w, h).toString('base64');
      body = `image=${encodeURIComponent(b64)}&type=scoremap`;
      if (Buffer.byteLength(body, 'utf8') <= maxBodyBytes || tries >= 8 || Math.min(w, h) < MIN_EDGE) break;
      tries++;
      const k = Math.sqrt(0.7);
      const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
      px = downsampleRGBA(px, w, h, dw, dh);
      w = dw; h = dh;
    }

    const t0 = Date.now();
    const res = await requestImpl(`${SEG_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body, 'utf8') },
      body,
      timeoutMs,
    });
    const json = parseJsonSafe(res.text);
    if (!json) {
      const e = new Error(`baidu.seg: 响应非 JSON（HTTP ${res.status}）`);
      e.retryable = res.status >= 500;
      throw e;
    }
    const parsed = parseSegResponse(json, { decodeImpl });
    let alpha = parsed.alpha;
    // 百度返回的图尺寸理论上等于上传尺寸；不等时按双线性放大回上传尺寸，避免下游错位
    if (parsed.width !== w || parsed.height !== h) {
      alpha = upscaleAlpha(alpha, parsed.width, parsed.height, w, h);
    }
    // 若上传时降过采样，放大回原始尺寸（调用方拿到的是与原图等大的 alpha）
    if (w !== width || h !== height) {
      alpha = upscaleAlpha(alpha, w, h, width, height);
    }
    return {
      alpha,
      width,
      height,
      provider: 'baidu',
      meta: {
        source: parsed.source,
        personNum: parsed.personNum,
        uploadPixels: w * h,
        uploadBytes: Buffer.byteLength(body, 'utf8'),
        downscaled: w !== width || h !== height,
        retryShrink: tries,
        latencyMs: Date.now() - t0,
      },
    };
  }

  return { getToken, segment, host: BAIDU_SEG_HOST, tokenCache };
}

module.exports = {
  BAIDU_SEG_HOST, TOKEN_URL, SEG_URL,
  DEFAULT_MAX_PIXELS, DEFAULT_MAX_BODY, DEFAULT_TIMEOUT_MS, TOKEN_SKEW_MS,
  resolveProvider, isTokenValid, parseTokenResponse, mapErrCode, isApiError,
  extractAlpha, parseSegResponse, stripB64,
  downsampleRGBA, upscaleAlpha,
  defaultRequest, makeBaiduSegClient,
};
