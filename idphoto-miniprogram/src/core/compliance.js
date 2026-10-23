// 合规预审引擎（纯逻辑，可单测）
// 输入 measured：{ widthPx, heightPx, dpi, fileKb, bg('white'|'blue'|'red'), headHeightRatio(0~1,可选) }
// 目标 specId
// 输出：{ pass, target, checks:[{key,label,pass,detail}], suggestions:[...] }

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

  // 4. 底色
  const bgOk = spec.bg.includes(measured.bg);
  checks.push({
    key: 'bg',
    label: '底色',
    pass: bgOk,
    detail: bgOk ? `底色 ${measured.bg} 合规` : `底色 ${measured.bg} 不在允许范围 ${spec.bg.join('/')}`,
  });

  // 5. 头部占比（可选）
  if (measured.headHeightRatio != null && spec.headHeightRatio != null) {
    const min = spec.headHeightRatio - 0.05;
    const max = spec.headHeightRatioMax != null ? spec.headHeightRatioMax + 0.02 : spec.headHeightRatio + 0.05;
    const hrOk = measured.headHeightRatio >= min && measured.headHeightRatio <= max;
    checks.push({
      key: 'head',
      label: '头部占比',
      pass: hrOk,
      detail: `实测 ${(measured.headHeightRatio * 100).toFixed(0)}%，建议 ${(min * 100).toFixed(0)}%~${(max * 100).toFixed(0)}%`,
    });
  }

  const pass = checks.every((c) => c.pass);
  const suggestions = pass ? [] : checks.filter((c) => !c.pass).map((c) => c.label);
  return { pass, target, checks, suggestions };
}

module.exports = { check, DIM_TOL };
