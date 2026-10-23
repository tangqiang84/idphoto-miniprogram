'use strict';
// T3 换装端侧贴图合成（owner 2026-10-23 决策：端侧贴图合成 MVP 路线）
// 输入：抠图结果（rgba + alpha）+ 自绘透明 PNG 西装模板 + 头肩定位
// 输出：合成后 RGBA（不修改输入）
// 注意：本模块只做几何贴合合成，不改五官（PRD D2 由人工自检兜底，D3 强制弹窗在页面层）

// 由抠图 alpha 计算人像包围盒（alpha>0.5 视为前景）
// 返回 {x, y, w, h}；无前景返回 null
function alphaBBox(alpha, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 0.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// 西装模板放置框（几何贴合规则，纯函数可单测）
// bbox  : 人像包围盒 {x,y,w,h}
// headH : 头高（faceDetect 人脸框高；无 faceDetect 时由调用方传 bbox.h*0.30 估算）
// 规则  : 肩宽 = bbox.w*1.5（肩宽大于头宽）；模板高 = bbox.h*0.55；顶部对齐颈部（头顶+0.85*headH）
function suitPlacement(bbox, headH) {
  if (!bbox || !headH || headH <= 0) throw new Error('suitPlacement: 缺少 bbox/headH');
  const w = bbox.w * 1.5;
  const h = bbox.h * 0.55;
  return {
    x: bbox.x + bbox.w / 2 - w / 2,
    y: bbox.y + headH * 0.85,
    w,
    h,
  };
}

// 贴图合成：将模板（tplW×tplH RGBA，领口居中于顶部）放置到 place 框
// 仅覆盖人体区域（alpha>0.5）且模板不透明的像素；其余像素原样保留；返回新 RGBA
function suitCompose(rgba, alpha, width, height, tpl, tplW, tplH, place) {
  if (!rgba || !alpha || !tpl) throw new Error('suitCompose: 缺少 rgba/alpha/tpl');
  const out = new Uint8ClampedArray(rgba);
  const x0 = Math.max(0, Math.round(place.x));
  const y0 = Math.max(0, Math.round(place.y));
  const x1 = Math.min(width, Math.round(place.x + place.w));
  const y1 = Math.min(height, Math.round(place.y + place.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const di = y * width + x;
      if (alpha[di] <= 0.5) continue; // 只贴人体区域
      // 最近邻重采样到放置框
      const sx = Math.min(tplW - 1, Math.floor((x - place.x) / place.w * tplW));
      const sy = Math.min(tplH - 1, Math.floor((y - place.y) / place.h * tplH));
      const si = sy * tplW + sx;
      const ta = tpl[si * 4 + 3];
      if (ta === 0) continue; // 模板透明处不覆盖
      out[di * 4] = tpl[si * 4];
      out[di * 4 + 1] = tpl[si * 4 + 1];
      out[di * 4 + 2] = tpl[si * 4 + 2];
    }
  }
  return out;
}

module.exports = { alphaBBox, suitPlacement, suitCompose };
