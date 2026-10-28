'use strict';
/**
 * 真实素材清单（SSOT）—— 证件照小程序业务验收的唯一输入源
 * ============================================================================
 * 【为什么有这个文件】
 * 2026-10-28 owner 批评：「你现在测试验证只是 26 张图，远远不够覆盖现有业务，
 * 还是要对业务功能与流程进行验证，我都提供真实图片了，为什么你还用你自己的图片验证」。
 * 根因：早期冒烟脚本默认输入是 `素材/测试图/test_standard.png` 等**自造合成图**
 *      （由 工具链/make_test_images.py 生成），这种人脸是画出来的，
 *      根本走不通抠图/裁切/换装/预审的真实链路 → 断言全绿但业务是坏的。
 *
 * 【本文件的契约】
 *   1. 真实头像清单（11 张，owner 提供）是**唯一**默认输入源。
 *   2. 合成图（素材/测试图/*）只允许出现在**显式声明的边界用例**里，
 *      且必须在输出里打印「合成图（仅用于边界用例）」字样 —— 见 SYNTHETIC_ASSETS。
 *   3. 路径一律基于 __dirname 推导（仓库根 = __dirname/..），不硬编码 /Users/tq。
 *
 * 【用途分类口径】
 *   positive        正例：真实人像，应能跑通全链路并产出合规成品
 *   negative-cartoon 负例-卡通：非真实人脸（FaceQ1411209084675.png），
 *                    百度人像分割检不出人 → 预期「未检测到人脸 / 抠图失败」
 *   negative-landscape 负例-横图：横构图（images (3).jpeg 500×333），
 *                    证件照场景不成立 → 预期降级/提示，不应产出「合规成品」
 *   lowres          低分辨率：像素不足以支撑目标规格（如 3652.jpg 200×300 < 600×800）
 *
 * 用法：
 *   const { listRealAssets, pickRealImages, getRealAsset } = require('./real_assets');
 *   listRealAssets();                       // 打印清单（含像素尺寸）
 *   pickRealImages({ purpose: 'positive' });// 只取正例
 *   pickRealImages({ limit: 3, shuffle: false });
 *
 * CLI（可独立跑）：
 *   NODE_OPTIONS= node 工具链/real_assets.js          # 打印清单
 *   NODE_OPTIONS= node 工具链/real_assets.js --json   # 输出 JSON（供其它脚本消费）
 *   NODE_OPTIONS= node 工具链/real_assets.js --purpose positive
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const REAL_DIR = path.join(ROOT, '素材', '真实头像');
const SYNTHETIC_DIR = path.join(ROOT, '素材', '测试图');

/**
 * 真实头像清单（owner 提供的 11 张）。
 * size 字段是**实测值**（2026-10-28 用 PIL 逐张读出），不是估计值。
 * 注意：文件名里含空格与反斜杠（`images\ (1).jpeg`）——那是文件名本身的字符，
 *       不是路径分隔符，处理时必须用 path.join + 精确文件名，不能 split('/')。
 */
const REAL_ASSETS = [
  {
    file: '111.jpg',
    purpose: 'positive',
    size: { width: 600, height: 798 },
    note: '半身正脸，背景较杂乱 → 走云端精修链路',
  },
  {
    file: '123.png',
    purpose: 'positive',
    size: { width: 295, height: 413 },
    note: '已是标准证件照比例（295×413 = 一寸 300dpi 目标像素）',
  },
  {
    file: '3652.jpg',
    purpose: 'lowres',
    size: { width: 200, height: 300 },
    note: '低分辨率 200×300（< 600×800 门槛）→ 应触发「原图清晰度不足」提示',
  },
  {
    file: '3f5c67b03f7f.jpg',
    purpose: 'positive',
    size: { width: 400, height: 400 },
    note: '方形成像',
  },
  {
    file: '91f990d7fa414d3d92a9377957b9be0f.jpg',
    purpose: 'positive',
    size: { width: 480, height: 480 },
    note: '方形成像',
  },
  {
    file: 'FaceQ1411209084675.png',
    purpose: 'negative-cartoon',
    size: { width: 590, height: 590 },
    note: '负例：卡通/动漫图，百度检不出人 → 预期「未检测到人脸」而非静默出图',
  },
  {
    file: 'images (1).jpeg',
    purpose: 'positive',
    size: { width: 447, height: 447 },
    note: '真实人像（文件名含空格与括号，需精确处理）',
  },
  {
    file: 'images (2).jpeg',
    purpose: 'positive',
    size: { width: 447, height: 447 },
    note: '真实人像',
  },
  {
    file: 'images (3).jpeg',
    purpose: 'negative-landscape',
    size: { width: 500, height: 333 },
    note: '负例：横图 500×333（宽>高）→ 证件照场景不成立',
  },
  {
    file: 'images (4).jpeg',
    purpose: 'positive',
    size: { width: 447, height: 447 },
    note: '真实人像',
  },
  {
    file: 'images.jpeg',
    purpose: 'positive',
    size: { width: 452, height: 679 },
    note: '真实人像',
  },
];

/**
 * 合成图清单 —— **只允许**用于显式声明的边界用例，且必须在输出里打印提示。
 * 禁止把它们当作冒烟/验收的默认输入。
 */
const SYNTHETIC_ASSETS = [
  {
    file: 'test_standard.png',
    reason: '合成图（仅用于边界用例）：纯色背景 + 几何人像，用于「抠图边界/色值精确性」等非真实人脸场景',
  },
  {
    file: 'test_complex.png',
    reason: '合成图（仅用于边界用例）：复杂背景，用于「背景复杂度检测（complexbg）」触发路径',
  },
  {
    file: 'test_lowres.png',
    reason: '合成图（仅用于边界用例）：低分辨率图，用于「分辨率不足提示」路径',
  },
  {
    file: 'test_real.png',
    reason: '合成图（仅用于边界用例）：大尺寸合成人像，用于「原图尺寸/缩放」路径',
  },
];

/** 合成图提示语（打印到 stdout / 报告里，确保不会静默混进业务验收） */
const SYNTHETIC_NOTICE = '合成图（仅用于边界用例）';

/** 负例清单（按用途） */
const NEGATIVE_PURPOSES = ['negative-cartoon', 'negative-landscape'];

function absOf(file) {
  return path.join(REAL_DIR, file);
}

/**
 * 读一个图片的像素尺寸。
 * 优先用纯 Node 手写解析（PNG/JPEG/GIF/BMP 头），避免引入图像库依赖；
 * 解析失败返回 null（不抛错 —— 清单函数不应因单张图损坏而整体失败）。
 */
function readImageSize(absPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch (e) {
    return null;
  }
  if (buf.length < 24) return null;

  // PNG: 89 50 4E 47 ... IHDR(width@16, height@20)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: 扫描 SOFn 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
    return null;
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  return null;
}

/**
 * 取得真实素材清单（带实测像素尺寸 + 文件存在性）。
 * @returns {Array<{file:string, absPath:string, purpose:string, size:{width:number,height:number},
 *                  sizeMeasured:{width:number,height:number}|null, exists:boolean, note:string}>}
 */
function listRealAssets(opts = {}) {
  const dir = opts.dir ? path.resolve(ROOT, opts.dir) : REAL_DIR;
  return REAL_ASSETS.map((a) => {
    const absPath = path.join(dir, a.file);
    const exists = fs.existsSync(absPath);
    const sizeMeasured = exists ? readImageSize(absPath) : null;
    return {
      ...a,
      absPath,
      exists,
      sizeMeasured,
      // 实测尺寸优先（清单里写死的是 2026-10-28 的快照，文件被替换时以实测为准）
      size: sizeMeasured || a.size,
      sizeMismatch: !!(sizeMeasured && (sizeMeasured.width !== a.size.width || sizeMeasured.height !== a.size.height)),
    };
  });
}

/**
 * 按用途挑选真实素材。
 * @param {object} [opts]
 * @param {string|string[]} [opts.purpose]  'positive' | 'negative-cartoon' | 'negative-landscape' | 'lowres'，可传数组
 * @param {boolean} [opts.includeNegatives] true = 连负例一起要（默认只要正例）
 * @param {boolean} [opts.excludeNegativeCartoon] 显式排除卡通负例
 * @param {number} [opts.limit] 最多取几张
 * @param {string} [opts.files] 逗号分隔的文件名子集过滤（模糊匹配）
 * @param {boolean} [opts.shuffle] 随机打散（默认保持清单顺序 → 可复现）
 * @param {boolean} [opts.mustExist] 只返回文件确实存在的（默认 true）
 * @returns {Array} 同 listRealAssets 的元素
 */
function pickRealImages(opts = {}) {
  let items = listRealAssets(opts);

  if (opts.mustExist !== false) items = items.filter((a) => a.exists);

  const purposes = opts.purpose
    ? (Array.isArray(opts.purpose) ? opts.purpose : [opts.purpose])
    : null;

  if (purposes) {
    items = items.filter((a) => purposes.indexOf(a.purpose) >= 0);
  } else if (opts.includeNegatives !== true) {
    // 默认口径：只要正例 + 低分辨率（低分辨率也是真实照片，考察降级路径）
    items = items.filter((a) => !NEGATIVE_PURPOSES.includes(a.purpose));
  }
  if (opts.excludeNegativeCartoon) {
    items = items.filter((a) => a.purpose !== 'negative-cartoon');
  }

  if (opts.files) {
    const keys = String(opts.files).split(',').map((s) => s.trim()).filter(Boolean);
    items = items.filter((a) => keys.some((k) => a.file.indexOf(k) >= 0));
  }

  if (opts.shuffle) {
    // 确定性洗牌（按文件名字符码排序哈希），保证可复现
    items = items.slice().sort((a, b) => {
      const h = (s) => s.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
      return h(a.file) - h(b.file);
    });
  }

  if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
  return items;
}

/** 按文件名取单张真实素材（找不到返回 null） */
function getRealAsset(file) {
  return listRealAssets().find((a) => a.file === file) || null;
}

/**
 * 合成图守卫：若传入路径落在 素材/测试图/ 下，返回提示信息（不得静默使用）。
 * @param {string|{absPath:string}} absPath 路径，或 pickRealAssets 的元素
 * @returns {string|null} 提示语；路径不是合成图则返回 null
 */
function syntheticNoticeFor(absPath) {
  if (absPath === null || absPath === undefined) return null;
  // 接受字符串路径，或 listRealAssets/pickRealImages 返回的资源对象
  const p = path.resolve(typeof absPath === 'string' ? absPath : absPath.absPath);
  if (!p.startsWith(SYNTHETIC_DIR)) return null;
  const base = path.basename(p);
  const known = SYNTHETIC_ASSETS.find((s) => s.file === base);
  return known ? known.reason : `合成图（仅用于边界用例）：${base}`;
}

/** 该文件是不是合成图 */
function isSynthetic(absPath) {
  return syntheticNoticeFor(absPath) !== null;
}

module.exports = {
  ROOT,
  REAL_DIR,
  SYNTHETIC_DIR,
  REAL_ASSETS,
  SYNTHETIC_ASSETS,
  SYNTHETIC_NOTICE,
  NEGATIVE_PURPOSES,
  readImageSize,
  listRealAssets,
  pickRealImages,
  getRealAsset,
  syntheticNoticeFor,
  isSynthetic,
};

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`真实素材清单（SSOT）

用法:
  node 工具链/real_assets.js                    # 打印清单
  node 工具链/real_assets.js --json             # JSON 输出
  node 工具链/real_assets.js --purpose positive # 只看某用途
  node 工具链/real_assets.js --negatives        # 连负例一起列出

用途分类:
  positive            真实人像正例（默认输入）
  lowres              真实照片但分辨率不足 → 降级路径
  negative-cartoon    负例：卡通图，检不出人脸
  negative-landscape  负例：横图，证件照场景不成立

注意: 合成图（素材/测试图/*）不在本清单内，只能用于显式声明的边界用例。`);
    process.exit(0);
  }

  const purpose = getArg('--purpose', '');
  const items = purpose
    ? pickRealImages({ purpose })
    : listRealAssets();

  if (args.includes('--json')) {
    console.log(JSON.stringify(items, null, 2));
    process.exit(0);
  }

  console.log(`真实素材目录: ${REAL_DIR}`);
  console.log(`共 ${items.length} 张\n`);
  const head = ['文件', '用途', '像素', '存在', '说明'];
  console.log(head.join(' | '));
  console.log('-'.repeat(80));
  for (const a of items) {
    console.log([
      a.file,
      a.purpose,
      `${a.size.width}×${a.size.height}`,
      a.exists ? 'Y' : 'N',
      a.note + (a.sizeMismatch ? ' ⚠尺寸与清单快照不符' : ''),
    ].join(' | '));
  }
  const missing = items.filter((a) => !a.exists);
  if (missing.length) {
    console.log(`\n⚠ 缺失 ${missing.length} 张: ${missing.map((a) => a.file).join(', ')}`);
    process.exit(2);
  }
  console.log('\n✅ 真实素材清单完整');
  console.log('提示: 合成图（素材/测试图/*）仅可用于显式声明的边界用例，不得作为默认输入。');
  process.exit(0);
}
