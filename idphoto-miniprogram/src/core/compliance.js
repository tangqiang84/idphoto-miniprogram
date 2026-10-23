// 合规预审引擎（纯逻辑，可单测）
// 输入 measured：{ widthPx, heightPx, dpi, fileKb, bg('white'|'blue'|'blueLight'|'red'|'gray'), headHeightRatio(0~1,可选) }
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

const { getSpec, getPixelSize, DPI_STD, DPI_HD } = require('./specLibrary');

const DIM_TOL = 2; // 像素容差

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

  // 3. 文件大小
  //    600dpi（印刷级用途）→ 提示项，不参与通过判定（依据见文件头注释）
  const isHd = dpi >= DPI_HD;
  const kbOk = (measured.fileKb || 0) <= spec.maxKb;
  checks.push({
    key: 'filesize',
    label: '文件大小',
    pass: kbOk,
    level: isHd ? 'advisory' : 'required',
    detail: isHd
      ? `实测 ${measured.fileKb || 0}KB（600dpi 印刷级用途，官方报名系统只校验像素/格式，此项仅提示；${spec.maxKb}KB 上限为 300dpi 口径）`
      : `实测 ${measured.fileKb || 0}KB，上限 ${spec.maxKb}KB`,
  });

  // 4. 底色（spec.bg 列出该规格允许的底色 key，blue / blueLight 为两个不同色值）
  const bgOk = spec.bg.includes(measured.bg);
  checks.push({
    key: 'bg',
    label: '底色',
    pass: bgOk,
    level: 'required',
    detail: bgOk
      ? `底色 ${measured.bg} 合规`
      : `底色 ${measured.bg} 不在允许范围 ${spec.bg.join('/')}`,
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
