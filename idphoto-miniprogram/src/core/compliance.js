// 合规预审引擎（纯逻辑，可单测）
// 输入 measured：{
//   widthPx, heightPx, dpi,
//   fileKb,                                   // 文件大小（KB）；未测量时传 undefined
//   bg,                                       // 底色：key（'blue'）或 HEX（'#438EDB' / '#438edb'）均可
//   headHeightRatio                           // 0~1，可选
// }
// 目标 specId
// 输出：{ pass, target, checks:[{key,label,pass,detail,level}], suggestions:[...] }
//
// 【2026-10-23 数值裁决】头部占比判定改为读取规格的显式区间
// （headHeightRatioMin / headHeightRatioMax），不再用「基准 ±0.05」推导。
// 原因：官方口径按各机构物理量给出（护照头长 28~33mm/48mm、驾照 19~22mm/32mm），
// 推导式无法表达非对称区间，且会误判 passport-cn（官方 58%~69%）。
//
// 【2026-10-23 owner 决策】600dpi 档的「文件大小」降级为**提示项**（level='advisory'）：
//   官方报名系统（学信网 / DS-160 等）只校验「像素 + KB + 格式」，从不校验 dpi 元数据；
//   600dpi 是印刷/冲印用途，像素 ×4 → 体积涨 2~4 倍（300dpi 一寸约 30~50KB →
//   600dpi 约 120~200KB），几乎必然超出按 300dpi 像素量设定的 KB 上限。
//   若仍按严格上限判定，会把一张完全合格的印刷级文件判成「文件大小不通过」——
//   这是误判。故 600dpi 时该项只作提示、不参与 pass 计算；300dpi 维持严格判定。
//   level='advisory' 的项不计入 suggestions（不阻断导出）。

const { getSpec, getPixelSize, bgKeyOf, hexOfBgKey, DPI_STD, DPI_HD } = require('./specLibrary');

const DIM_TOL = 2; // 像素容差

/**
 * 底色判定：measured.bg 同时接受「bg key」（'blue'）与「HEX 字符串」（'#438EDB' / '#438edb'）。
 *
 * 【为什么必须两种都收】换底色之后调用方传上来的是 HEX（renderService 的 bgHex 就是 HEX），
 * 而 spec.bg 里存的是 key。原先只做 spec.bg.includes(measured.bg) → HEX 永远匹配不上任何 key
 * → 底色项被误判为「不通过」，用户看到的报告是错的。
 *
 * 【口径统一】色值表只存在于 specLibrary.BG，本模块通过 bgKeyOf() 反查，不硬编码第二份。
 *   · key 形式：命中 spec.bg 里的同名 key（保持既有行为，零回归）；
 *   · HEX 形式：先反查成标准色 key，再看该 key 是否在 spec.bg 允许列表里。
 *     注意这是「按标准色归档」而非「按色值严格相等」：实测底色经过 JPEG 压缩有偏移，
 *     但只要调用方给的是标准色 HEX，就应按标准色 key 归档。
 *   · 两者都不是标准底色（如 'unknown'、'#123456'）→ 不通过。
 */
function bgMatches(spec, measuredBg) {
  if (typeof measuredBg !== 'string' || !measuredBg) return false;
  const key = bgKeyOf(measuredBg);
  if (key) return spec.bg.includes(key);
  // key 形式（大小写敏感，与既有行为一致）：'blue' 直接比对
  return spec.bg.includes(measuredBg);
}

/** 把 measured.bg 显示成人话（HEX 与 key 互为标注，便于排查误判） */
function bgDisplay(measuredBg) {
  if (typeof measuredBg !== 'string' || !measuredBg) return String(measuredBg);
  const key = bgKeyOf(measuredBg);
  if (key) return `${measuredBg}（${key}）`;
  const hex = hexOfBgKey(measuredBg);
  if (hex) return `${measuredBg}（${hex}）`;
  return measuredBg;
}


function check(specId, measured) {
  const spec = getSpec(specId);
  if (!spec) return { pass: false, checks: [], error: '未知规格: ' + specId };
  const dpi = measured.dpi || DPI_STD;
  const target = getPixelSize(spec, dpi);
  const checks = [];

  // 1. 尺寸
  const wOk = Math.abs(measured.widthPx - target.width) <= DIM_TOL;
  const hOk = Math.abs(measured.heightPx - target.height) <= DIM_TOL;
  checks.push({
    key: 'dimension',
    label: '尺寸',
    pass: wOk && hOk,
    level: 'required',
    detail: `实测 ${measured.widthPx}×${measured.heightPx}px，要求 ${target.width}×${target.height}px（容差±${DIM_TOL}）`,
  });

  // 2. 分辨率 dpi
  const dpiOk = dpi >= DPI_STD;
  checks.push({
    key: 'dpi',
    label: '分辨率',
    pass: dpiOk,
    level: 'required',
    detail: `实测 ${dpi}dpi，要求 ≥${DPI_STD}dpi`,
  });

  // 3. 文件大小（区间判定：下限 ≤ 实测 ≤ 上限）
  //    600dpi（印刷级用途）→ 提示项，不参与通过判定（依据见文件头注释）
  //    【2026-10-28 新增下限】PRD 8.1 是「20KB–200KB」区间（美国签证 54–240KB），
  //    原实现只判上限 → 一张 3KB 的空图也能「通过文件大小」项。下限用规格的 minKb，
  //    规格没定义 minKb 时不设下限（保持对旧规格的零回归）。
  //    ⚠️ 「未测量到 fileKb」与「测得 fileKb 很小」必须区分：
  //       前者（undefined/NaN）无从判断 → 不判失败（保持旧行为，避免误伤未传该字段的调用方）；
  //       后者是实打实的空图/糊图 → 判失败。
  const isHd = dpi >= DPI_HD;
  const hasKb = typeof measured.fileKb === 'number' && isFinite(measured.fileKb);
  const fileKb = hasKb ? measured.fileKb : 0;
  const minKb = typeof spec.minKb === 'number' ? spec.minKb : null;
  const kbOverMax = hasKb && fileKb > spec.maxKb;
  const kbUnderMin = hasKb && minKb != null && fileKb < minKb;
  const kbOk = !kbOverMax && !kbUnderMin;
  const kbRange = minKb != null ? `${minKb}KB~${spec.maxKb}KB` : `≤${spec.maxKb}KB`;
  checks.push({
    key: 'filesize',
    label: '文件大小',
    pass: kbOk,
    level: isHd ? 'advisory' : 'required',
    detail: !hasKb
      ? `未测量到文件大小，跳过该项（要求 ${kbRange}）`
      : isHd
        ? `实测 ${fileKb}KB（600dpi 印刷级用途，官方报名系统只校验像素/格式，此项仅提示；${kbRange} 为 300dpi 口径）`
        : kbUnderMin
          ? `实测 ${fileKb}KB，低于下限 ${minKb}KB（要求 ${kbRange}），文件可能为空图或质量过低`
          : `实测 ${fileKb}KB，要求 ${kbRange}`,
  });

  // 4. 底色（spec.bg 列出该规格允许的底色 key，blue / blueLight 为两个不同色值）
  //    measured.bg 支持 key 与 HEX 两种形态（见 bgMatches 注释）
  const bgOk = bgMatches(spec, measured.bg);
  checks.push({
    key: 'bg',
    label: '底色',
    pass: bgOk,
    level: 'required',
    detail: bgOk
      ? `底色 ${bgDisplay(measured.bg)} 合规`
      : `底色 ${bgDisplay(measured.bg)} 不在允许范围 ${spec.bg.join('/')}`,
  });

  // 5. 头部占比（可选；仅当实测与规格都具备区间/基准时判定）
  const min = spec.headHeightRatioMin;
  const max = spec.headHeightRatioMax;
  if (measured.headHeightRatio != null && (min != null || max != null)) {
    const lo = min != null ? min : 0;
    const hi = max != null ? max : 1;
    const hrOk = measured.headHeightRatio >= lo && measured.headHeightRatio <= hi;
    checks.push({
      key: 'head',
      label: '头部占比',
      pass: hrOk,
      level: 'required',
      detail: `实测 ${(measured.headHeightRatio * 100).toFixed(0)}%，要求 ${(lo * 100).toFixed(0)}%~${(hi * 100).toFixed(0)}%`,
    });
  }

  // pass 只由 required 级项决定；advisory 项（如 600dpi 的 KB）仅提示，不阻断
  const required = checks.filter((c) => c.level !== 'advisory');
  const pass = required.every((c) => c.pass);
  const suggestions = pass ? [] : required.filter((c) => !c.pass).map((c) => c.label);
  return { pass, target, checks, suggestions, dpi };
}

module.exports = { check, DIM_TOL };
