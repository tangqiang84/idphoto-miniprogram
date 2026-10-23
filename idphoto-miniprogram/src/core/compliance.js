// 合规预审引擎（纯逻辑，可单测）
// 输入 measured：{ widthPx, heightPx, dpi, fileKb, bg('white'|'blue'|'blueLight'|'red'|'gray'), headHeightRatio(0~1,可选) }
// 目标 specId
// 输出：{ pass, target, checks:[{key,label,pass,detail}], suggestions:[...] }
//
// 【2026-10-23 数值裁决】头部占比判定改为读取规格的显式区间
// （headHeightRatioMin / headHeightRatioMax），不再用「基准 ±0.05」推导。
// 原因：官方口径按各机构物理量给出（护照头长 28~33mm/48mm、驾照 19~22mm/32mm），
// 推导式无法表达非对称区间，且会误判 passport-cn（官方 58%~69%）。

const { getSpec, getPixelSize } = require('./specLibrary');

const DIM_TOL = 2; // 像素容差

function check(specId, measured) {
  const spec = getSpec(specId);
  if (!spec) return { pass: false, checks: [], error: '未知规格: ' + specId };
  const target = getPixelSize(spec, measured.dpi || 300);
  const checks = [];

  // 1. 尺寸
  const wOk = Math.abs(measured.widthPx - target.width) <= DIM_TOL;
  const hOk = Math.abs(measured.heightPx - target.height) <= DIM_TOL;
  checks.push({
    key: 'dimension',
    label: '尺寸',
    pass: wOk && hOk,
    detail: `实测 ${measured.widthPx}×${measured.heightPx}px，要求 ${target.width}×${target.height}px（容差±${DIM_TOL}）`,
  });

  // 2. 分辨率 dpi
  const dpiOk = (measured.dpi || 0) >= 300;
  checks.push({
    key: 'dpi',
    label: '分辨率',
    pass: dpiOk,
    detail: `实测 ${measured.dpi || 0}dpi，要求 ≥300dpi`,
  });

  // 3. 文件大小
  const kbOk = (measured.fileKb || 0) <= spec.maxKb;
  checks.push({
    key: 'filesize',
    label: '文件大小',
    pass: kbOk,
    detail: `实测 ${measured.fileKb || 0}KB，上限 ${spec.maxKb}KB`,
  });

  // 4. 底色（spec.bg 列出该规格允许的底色 key，blue / blueLight 为两个不同色值）
  const bgOk = spec.bg.includes(measured.bg);
  checks.push({
    key: 'bg',
    label: '底色',
    pass: bgOk,
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
      detail: `实测 ${(measured.headHeightRatio * 100).toFixed(0)}%，要求 ${(lo * 100).toFixed(0)}%~${(hi * 100).toFixed(0)}%`,
    });
  }

  const pass = checks.every((c) => c.pass);
  const suggestions = pass ? [] : checks.filter((c) => !c.pass).map((c) => c.label);
  return { pass, target, checks, suggestions };
}

module.exports = { check, DIM_TOL };
