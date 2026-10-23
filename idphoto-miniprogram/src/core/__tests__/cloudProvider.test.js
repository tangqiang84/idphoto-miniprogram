'use strict';
// 商用 API 接入专项单测：百度智能云「人像分割」
// 覆盖：PNG 编解码 → token/错误码解析 → 客户端（mock 网络）→ 云函数 provider 路由与降级
//       → 前端云端结果接受判据 → 合规静态断言
//
// 设计原则：网络全部依赖注入，**不联网、不烧额度、不需要真密钥**也能跑全路径。
// 运行：npm run test:core（与 core.test.js 一起跑，已改为跑整个 __tests__ 目录）

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');

const CF = path.join(__dirname, '..', '..', '..', 'cloudfunctions', 'matting');
const { encodePNG, decodePNG, crc32 } = require(path.join(CF, 'png'));
const baidu = require(path.join(CF, 'baiduSeg'));
const fn = require(path.join(CF, 'index'));
const { shouldAcceptCloudAlpha, isDomesticSuffix } = require('../mattingCloud');
const { estimateQuality } = require('../mattingLocal');

// ===================== 测试辅助：手工构造灰度 PNG（模拟百达 scoremap 返回） =====================
// 为什么要手工构造：encodePNG 只输出 RGBA，而百度 scoremap 是 **colorType 0 灰度图**，
// 必须验证解码器能正确处理灰度（否则线上会全部走到「不支持的 colorType」降级分支）。
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function makeGrayPNG(w, h, fn) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter 0
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = fn(x, y) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8bit 灰度
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeRgba(w, h, fn) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const c = fn(x, y);
    a[i * 4] = c[0]; a[i * 4 + 1] = c[1]; a[i * 4 + 2] = c[2]; a[i * 4 + 3] = c[3];
  }
  return a;
}

// ===================== 一、PNG 编解码 =====================
test('PNG：RGBA 编码→解码往返完全一致（含 alpha 变化）', () => {
  const w = 17, h = 9;
  const src = makeRgba(w, h, (x, y) => [(x * 13) % 256, (y * 29) % 256, (x + y) % 256, (x * y) % 256]);
  const d = decodePNG(encodePNG(src, w, h));
  assert.strictEqual(d.width, w);
  assert.strictEqual(d.height, h);
  assert.strictEqual(d.colorType, 6);
  for (let i = 0; i < w * h * 4; i++) assert.strictEqual(d.data[i], src[i], `第 ${i} 字节不一致`);
});

test('PNG：能解码百度 scoremap 形式的灰度图（colorType 0）', () => {
  const w = 12, h = 8;
  const png = makeGrayPNG(w, h, (x, y) => (x + y) * 10);
  const d = decodePNG(png);
  assert.strictEqual(d.colorType, 0);
  assert.strictEqual(d.width, w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const g = ((x + y) * 10) & 0xff;
    assert.strictEqual(d.data[i * 4], g);       // R = 灰度
    assert.strictEqual(d.data[i * 4 + 3], 255); // A 补 255
  }
});

test('PNG：非法输入必须抛错（宁可降级，不能静默出错）', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /签名不匹配/);
  // 位深 16 的 PNG：改 IHDR 第 8 字节
  const bad = Buffer.from(encodePNG(makeRgba(4, 4, () => [1, 2, 3, 255]), 4, 4));
  bad[8 + 8 + 8] = 16;
  assert.throws(() => decodePNG(bad), /位深/);
  assert.throws(() => encodePNG(new Uint8ClampedArray(4), 100, 100), /像素数据不足/);
});

// ===================== 二、provider 决策与 token =====================
test('resolveProvider：未配置凭据走影子实现，配置了走百度', () => {
  assert.strictEqual(baidu.resolveProvider({}).provider, 'shadow');
  assert.strictEqual(baidu.resolveProvider({ apiKey: 'ak', secretKey: '' }).provider, 'shadow');
  assert.strictEqual(baidu.resolveProvider({ apiKey: 'ak', secretKey: 'sk' }).provider, 'baidu');
  assert.strictEqual(baidu.resolveProvider({ apiKey: 'ak', secretKey: 'sk', enabled: false }).provider, 'shadow');
  assert.ok(/BAIDU_ENABLED/.test(baidu.resolveProvider({ apiKey: 'ak', secretKey: 'sk', enabled: false }).reason));
});

test('isTokenValid：空 token / 临近过期都判无效（提前 24h 续期）', () => {
  const now = 1000000;
  assert.strictEqual(baidu.isTokenValid({ token: '', expiresAt: now + 1e9, now }), false);
  assert.strictEqual(baidu.isTokenValid({ token: 't', expiresAt: now + 30 * 86400e3, now }), true);
  // 距离过期只剩 12 小时 < 24 小时 skew → 判无效，触发续期
  assert.strictEqual(baidu.isTokenValid({ token: 't', expiresAt: now + 12 * 3600e3, now }), false);
});

test('parseTokenResponse：正常解析 / 缺字段抛错 / error 抛错', () => {
  const r = baidu.parseTokenResponse({ access_token: 'abc', expires_in: 2592000 }, 0);
  assert.strictEqual(r.token, 'abc');
  assert.strictEqual(r.expiresAt, 2592000 * 1000);
  assert.throws(() => baidu.parseTokenResponse({ error: 'invalid_client', error_description: 'unknown client id' }, 0), /invalid_client/);
  assert.throws(() => baidu.parseTokenResponse({ expires_in: 100 }, 0), /缺少 access_token/);
});

test('mapErrCode：110 未开通不可重试、18 QPS 可重试、未知码默认不可重试', () => {
  const e110 = baidu.mapErrCode(110, 'no permission');
  assert.strictEqual(e110.retryable, false);
  assert.ok(/开通/.test(e110.msg));
  const e18 = baidu.mapErrCode(18, 'qps limit');
  assert.strictEqual(e18.retryable, true);
  assert.ok(/QPS/.test(e18.msg));
  assert.strictEqual(baidu.mapErrCode(99999, 'x').retryable, false);
});

// ===================== 三、响应解析 =====================
test('parseSegResponse：优先取 scoremap 灰度作 alpha', () => {
  const png = makeGrayPNG(4, 4, (x) => (x < 2 ? 255 : 0));
  const r = baidu.parseSegResponse({ scoremap: png.toString('base64'), person_num: 1 });
  assert.strictEqual(r.source, 'scoremap');
  assert.strictEqual(r.width, 4);
  assert.strictEqual(r.alpha[0], 1);      // 灰度 255 → alpha 1
  assert.strictEqual(r.alpha[3], 0);      // 灰度 0 → alpha 0
  assert.strictEqual(r.personNum, 1);
});

test('parseSegResponse：scoremap 缺失时回退 foreground 的 A 通道', () => {
  const fg = encodePNG(makeRgba(4, 4, (x) => [10, 20, 30, x < 2 ? 255 : 0]), 4, 4);
  const r = baidu.parseSegResponse({ foreground: fg.toString('base64') });
  assert.strictEqual(r.source, 'foreground');
  assert.strictEqual(r.alpha[0], 1);
  assert.strictEqual(r.alpha[3], 0);
});

test('parseSegResponse：业务错误码抛错并带 code/retryable；两者皆无也抛错', () => {
  try {
    baidu.parseSegResponse({ error_code: 110, error_msg: 'no auth' });
    assert.fail('应当抛错');
  } catch (e) {
    assert.strictEqual(e.code, 110);
    assert.strictEqual(e.retryable, false);
  }
  assert.throws(() => baidu.parseSegResponse({ log_id: 1 }), /既无 scoremap 也无 foreground/);
});

test('stripB64：剔除换行与空格（部分 SDK 输出带换行）', () => {
  assert.strictEqual(baidu.stripB64('AB\nCD EF\r\n'), 'ABCDEF');
});

test('extractAlpha：scoremap 取 R 通道，foreground 取 A 通道', () => {
  const d = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 128]) };
  assert.deepStrictEqual(Array.from(baidu.extractAlpha(d, 'scoremap')), [1, 0]);
  assert.ok(Math.abs(baidu.extractAlpha(d, 'foreground')[1] - 128 / 255) < 1e-6);
});

// ===================== 四、客户端（mock 网络，不联网） =====================
function mockNet(segFn) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.indexOf('/oauth/2.0/token') >= 0) {
      return { status: 200, text: JSON.stringify({ access_token: 'tok-' + calls.length, expires_in: 2592000 }) };
    }
    // 解析上传的 PNG → 生成同尺寸灰度 scoremap 返回，形成真实闭环
    const m = /image=([^&]*)/.exec(opts.body || '');
    assert.ok(m, '请求体应含 image=');
    const up = decodePNG(Buffer.from(decodeURIComponent(m[1]), 'base64'));
    return { status: 200, text: JSON.stringify(segFn(up)) };
  };
  return { calls, impl };
}

function clientWith(net, extra) {
  return baidu.makeBaiduSegClient(Object.assign({
    apiKey: 'ak', secretKey: 'sk', requestImpl: net.impl, timeoutMs: 1000,
  }, extra || {}));
}

test('客户端：完整链路跑通（编码→上传→解码→放大回原尺寸）', async () => {
  const net = mockNet((up) => ({ log_id: 1, scoremap: makeGrayPNG(up.width, up.height, (x) => (x < up.width / 2 ? 255 : 0)).toString('base64'), person_num: 1 }));
  const cli = clientWith(net);
  const w = 64, h = 48;
  const rgba = makeRgba(w, h, (x) => [x * 3 % 256, 100, 200, 255]);
  const r = await cli.segment(rgba, w, h);
  assert.strictEqual(r.provider, 'baidu');
  assert.strictEqual(r.width, w);
  assert.strictEqual(r.height, h);
  assert.strictEqual(r.alpha.length, w * h);
  assert.strictEqual(r.meta.source, 'scoremap');
  assert.strictEqual(r.meta.personNum, 1);
  // 左半边 alpha=1、右半边 alpha=0
  assert.strictEqual(r.alpha[0], 1);
  assert.strictEqual(r.alpha[w - 1], 0);
  // token 只取了一次（缓存生效）
  assert.strictEqual(net.calls.filter((c) => c.url.indexOf('/oauth/') >= 0).length, 1);
});

test('客户端：同一实例第二次调用复用 token（不重复换取，省一次网络往返）', async () => {
  const net = mockNet((up) => ({ scoremap: makeGrayPNG(up.width, up.height, () => 200).toString('base64') }));
  const cli = clientWith(net);
  await cli.segment(makeRgba(8, 8, () => [1, 2, 3, 255]), 8, 8);
  await cli.segment(makeRgba(8, 8, () => [1, 2, 3, 255]), 8, 8);
  assert.strictEqual(net.calls.filter((c) => c.url.indexOf('/oauth/') >= 0).length, 1);
});

test('客户端：像素超 512×512 时先降采样上传，结果放大回原尺寸', async () => {
  const net = mockNet((up) => ({ scoremap: makeGrayPNG(up.width, up.height, () => 255).toString('base64') }));
  const cli = clientWith(net);
  const w = 900, h = 900;
  const r = await cli.segment(makeRgba(w, h, () => [120, 130, 140, 255]), w, h);
  assert.strictEqual(r.meta.downscaled, true);
  assert.ok(r.meta.uploadPixels <= 512 * 512 + 1, `上传像素应被封顶，实际 ${r.meta.uploadPixels}`);
  assert.ok(r.meta.uploadBytes <= baidu.DEFAULT_MAX_BODY, 'urlencode 后 body 必须 ≤4MB');
  assert.strictEqual(r.alpha.length, w * h, '返回 alpha 必须是原尺寸');
  assert.strictEqual(r.width, w);
});

test('客户端：body 超限时继续缩小重试（urlencode 膨胀保护）', async () => {
  // 造一张极难压缩的噪声图，逼出 body 超限分支
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
  const net = mockNet((up) => ({ scoremap: makeGrayPNG(up.width, up.height, () => 255).toString('base64') }));
  const cli = baidu.makeBaiduSegClient({
    apiKey: 'ak', secretKey: 'sk', requestImpl: net.impl,
    maxPixels: 400 * 400, maxBodyBytes: 20000, // 故意把上限调到很小
  });
  const w = 400, h = 400;
  const r = await cli.segment(makeRgba(w, h, () => [rnd(), rnd(), rnd(), 255]), w, h);
  assert.ok(r.meta.retryShrink > 0, '应触发至少一次缩小重试');
  assert.ok(r.meta.uploadPixels < w * h, '上传像素必须被压到原图以下');
  assert.strictEqual(r.alpha.length, w * h, '即便多次缩小，返回 alpha 仍是原尺寸');
});

test('客户端：token 过期后自动续期', async () => {
  let n = 0;
  const net = {
    calls: [],
    impl: async (url, opts) => {
      net.calls.push(url);
      if (url.indexOf('/oauth/') >= 0) return { status: 200, text: JSON.stringify({ access_token: 'tok' + (++n), expires_in: 1 }) }; // 1 秒后过期
      const m = /image=([^&]*)/.exec(opts.body);
      const up = decodePNG(Buffer.from(decodeURIComponent(m[1]), 'base64'));
      return { status: 200, text: JSON.stringify({ scoremap: makeGrayPNG(up.width, up.height, () => 255).toString('base64') }) };
    },
  };
  const cli = baidu.makeBaiduSegClient({ apiKey: 'ak', secretKey: 'sk', requestImpl: net.impl });
  const px = makeRgba(8, 8, () => [1, 2, 3, 255]);
  await cli.segment(px, 8, 8);
  await new Promise((r) => setTimeout(r, 1200)); // 等 token 过期
  await cli.segment(px, 8, 8);
  assert.strictEqual(net.calls.filter((u) => u.indexOf('/oauth/') >= 0).length, 2, '过期后应重新换取 token');
});

test('客户端：百度返回错误码时抛错（由调用方降级）', async () => {
  const net = {
    impl: async (url) => {
      if (url.indexOf('/oauth/') >= 0) return { status: 200, text: JSON.stringify({ access_token: 't', expires_in: 2592000 }) };
      return { status: 200, text: JSON.stringify({ error_code: 110, error_msg: 'no permission' }) };
    },
  };
  const cli = clientWith(net);
  await assert.rejects(
    () => cli.segment(makeRgba(16, 16, () => [1, 2, 3, 255]), 16, 16),
    (e) => e.code === 110 && e.retryable === false
  );
});

test('客户端：响应非 JSON 时抛错且标记可重试（5xx）', async () => {
  const net = {
    impl: async (url) => {
      if (url.indexOf('/oauth/') >= 0) return { status: 200, text: JSON.stringify({ access_token: 't', expires_in: 2592000 }) };
      return { status: 502, text: '<html>bad gateway</html>' };
    },
  };
  const cli = clientWith(net);
  await assert.rejects(() => cli.segment(makeRgba(16, 16, () => [1, 2, 3, 255]), 16, 16), (e) => e.retryable === true);
});

// ===================== 五、云函数 provider 路由与降级 =====================
function baseEvent(w, h) {
  const rgba = makeRgba(w, h, (x, y) => (x + y) % 2 ? [200, 180, 160, 255] : [40, 60, 90, 255]);
  return {
    region: 'CN', purpose: 'matting_enhance', retain: false, train: false, consent: 'faceCloudEnhance',
    width: w, height: h, image: Buffer.from(rgba.buffer).toString('base64'),
  };
}

test('云函数：未配置凭据 → 走影子实现且不报错', async () => {
  const r = await fn.handleMatting(baseEvent(32, 32), { env: {} });
  assert.strictEqual(r.provider, 'shadow');
  assert.strictEqual(r.region, 'CN');
  assert.ok(r.alphaB64 && r.alphaB64.length > 0);
});

test('云函数：配置凭据 + 客户端成功 → provider=baidu 且回传元数据', async () => {
  const r = await fn.handleMatting(baseEvent(32, 32), {
    env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' },
    clientFactory: () => ({
      host: 'aip.baidubce.com',
      segment: async (rgba, w, h) => ({ alpha: new Float32Array(w * h).fill(0.7), width: w, height: h, provider: 'baidu', meta: { source: 'scoremap', personNum: 1, latencyMs: 12 } }),
    }),
  });
  assert.strictEqual(r.provider, 'baidu');
  assert.strictEqual(r.providerMeta.source, 'scoremap');
  assert.strictEqual(r.providerMeta.personNum, 1);
  // alpha=0.7 → 字节 178 或 179（0.7*255 是浮点，两端都可能，故用容差）
  const bytes = Buffer.from(r.alphaB64, 'base64');
  assert.strictEqual(bytes.length, 32 * 32);
  assert.ok(Math.abs(bytes[0] - 0.7 * 255) <= 1, `alpha 编码偏差过大：${bytes[0]}`);
});

test('云函数：百度失败 → 降级影子实现，仍出图并回传降级原因', async () => {
  const r = await fn.handleMatting(baseEvent(32, 32), {
    env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' },
    clientFactory: () => ({ host: 'aip.baidubce.com', segment: async () => { const e = new Error('baidu.seg: [110] 接口权限未开通'); e.code = 110; e.retryable = false; throw e; } }),
  });
  assert.strictEqual(r.provider, 'shadow', '必须降级而不是失败');
  assert.strictEqual(r.providerMeta.fallbackFrom, 'baidu');
  assert.strictEqual(r.providerMeta.code, 110);
  assert.ok(r.alphaB64 && r.alphaB64.length > 0, '降级后仍要出图');
});

test('云函数：尺寸越界（最短边<15）不浪费调用，直接影子实现', async () => {
  const r = await fn.handleMatting(baseEvent(10, 200), {
    env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' },
    clientFactory: () => ({ segment: async () => { throw new Error('不该被调用'); } }),
  });
  assert.strictEqual(r.provider, 'shadow');
  assert.ok(/尺寸越界/.test(r.providerMeta.reason));
});

test('云函数：合规闸门先于一切（无授权 403 / 非境内 451）', async () => {
  const noConsent = Object.assign(baseEvent(16, 16), { consent: 'x' });
  const r1 = await fn.handleMatting(noConsent, { env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' } });
  assert.strictEqual(r1.code, 403);
  const abroad = Object.assign(baseEvent(16, 16), { region: 'US' });
  const r2 = await fn.handleMatting(abroad, { env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' } });
  assert.strictEqual(r2.code, 451);
});

test('云函数：event.provider=shadow 可强制走影子实现（灰度/排障用）', async () => {
  const ev = Object.assign(baseEvent(16, 16), { provider: 'shadow' });
  const r = await fn.handleMatting(ev, {
    env: { BAIDU_API_KEY: 'ak', BAIDU_SECRET_KEY: 'sk' },
    clientFactory: () => ({ segment: async () => { throw new Error('不该被调用'); } }),
  });
  assert.strictEqual(r.provider, 'shadow');
  assert.ok(/显式指定/.test(r.providerMeta.reason));
});

// ===================== 六、前端云端结果接受判据 =====================
test('判据：真模型软 alpha 不被误杀（这是接百度最关键的一条）', () => {
  const n = 400;
  // 本地：接近二值的 alpha（中间值极少）→ confidence 高
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) local[i] = i < n * 0.4 ? 1 : 0;
  // 云端：软 alpha，边缘 10% 落在 0.2~0.8 → ambiguous 高、confidence 低，但质量更好
  const cloud = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < n * 0.35) cloud[i] = 1;
    else if (i < n * 0.45) cloud[i] = 0.2 + (i % 5) * 0.15;
    else cloud[i] = 0;
  }
  const qc = estimateQuality(cloud), ql = estimateQuality(local);
  assert.ok(qc.confidence < ql.confidence, '前提：软 alpha 的 confidence 确实更低（否则本用例无意义）');
  const v = shouldAcceptCloudAlpha({ cloudAlpha: cloud, localAlpha: local, provider: 'baidu' });
  assert.strictEqual(v.accept, true, '真模型不能被 confidence 判据误杀');
  assert.strictEqual(v.reason, 'real_model_soft_alpha');
});

test('判据：退化结果（全 0 / 全 1）与前景大幅偏移都要拒绝', () => {
  const local = new Float32Array(400).fill(0);
  for (let i = 0; i < 160; i++) local[i] = 1;
  const allZero = new Float32Array(400);
  assert.strictEqual(shouldAcceptCloudAlpha({ cloudAlpha: allZero, localAlpha: local, provider: 'baidu' }).reason, 'cloud_foreground_degenerate');
  const allOne = new Float32Array(400).fill(1); // 整张图都判成前景 = 退化（>99.5%）
  assert.strictEqual(shouldAcceptCloudAlpha({ cloudAlpha: allOne, localAlpha: local, provider: 'baidu' }).reason, 'cloud_foreground_degenerate');
  // 前景占比 90% vs 本地 40% → 分歧过大
  const shifted = new Float32Array(400);
  for (let i = 0; i < 360; i++) shifted[i] = 1;
  const v2 = shouldAcceptCloudAlpha({ cloudAlpha: shifted, localAlpha: local, provider: 'baidu' });
  assert.strictEqual(v2.accept, false);
  assert.strictEqual(v2.reason, 'cloud_foreground_shift');
});

test('判据：local-stub 豁免；未知 provider 沿用 confidence 比较', () => {
  const n = 100;
  const local = new Float32Array(n); for (let i = 0; i < 50; i++) local[i] = 1;
  const worse = new Float32Array(n); for (let i = 0; i < 50; i++) worse[i] = 0.5; // 歧义更多
  assert.strictEqual(shouldAcceptCloudAlpha({ cloudAlpha: worse, localAlpha: local, provider: 'local-stub' }).accept, true);
  const v = shouldAcceptCloudAlpha({ cloudAlpha: worse, localAlpha: local, provider: null });
  assert.strictEqual(v.accept, false);
  assert.strictEqual(v.reason, 'cloud_confidence_lower');
});

// ===================== 七、合规静态断言 =====================
test('合规：百度主机在境内白名单内（数据不出境）', () => {
  assert.ok(isDomesticSuffix(baidu.BAIDU_SEG_HOST), `${baidu.BAIDU_SEG_HOST} 必须被判定为境内`);
  assert.ok(baidu.SEG_URL.indexOf('/rest/2.0/image-classify/v1/body_seg') >= 0);
});

test('合规：云函数源码不得硬编码任何密钥（只能走环境变量）', () => {
  for (const f of ['index.js', 'baiduSeg.js', 'png.js']) {
    const src = fs.readFileSync(path.join(CF, f), 'utf8');
    assert.ok(!/BAIDU_API_KEY\s*=\s*['"][A-Za-z0-9]{8,}/.test(src), `${f} 疑似硬编码 API Key`);
    assert.ok(!/BAIDU_SECRET_KEY\s*=\s*['"][A-Za-z0-9]{8,}/.test(src), `${f} 疑似硬编码 Secret Key`);
    assert.ok(!/client_secret=[A-Za-z0-9]{8,}/.test(src), `${f} 疑似硬编码 client_secret`);
  }
});

test('合规：云函数不得打印像素或 token（AC8 审计只记元数据）', () => {
  const src = fs.readFileSync(path.join(CF, 'index.js'), 'utf8');
  assert.ok(!/console\.log\([^)]*(image|rgba|alphaB64)/i.test(src), '禁止打印像素字段');
  assert.ok(!/console\.log\([^)]*token/i.test(src), '禁止打印 token');
});
