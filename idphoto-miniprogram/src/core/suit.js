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
//
// 【2026-10-23 owner 决策 600dpi 开放】采样方式由「最近邻」改为「双线性」：
//   模板源分辨率固定 400×400，而放置框尺寸随工作图缩放 ——
//   300dpi 工作图（长边 800）放置框约 500px，400→500 放大尚可；
//   600dpi 工作图（长边可达 1600）放置框可达 1400px+，最近邻会出现明显锯齿与色块。
//   双线性在两个方向都做插值，放大后边缘平滑，代价仅是每像素多几次乘加（可接受）。
// 注意：alpha 通道单独插值会���致半透明边界的颜色渗染（premultiplied 问题），
//   故对 RGB 与 A 分别插值后按 A 加权混合，避免出现黑边。
function suitCompose(rgba, alpha, width, height, tpl, tplW, tplH, place) {
  if (!rgba || !alpha || !tpl) throw new Error('suitCompose: 缺少 rgba/alpha/tpl');
  const out = new Uint8ClampedArray(rgba);
  const x0 = Math.max(0, Math.round(place.x));
  const y0 = Math.max(0, Math.round(place.y));
  const x1 = Math.min(width, Math.round(place.x + place.w));
  const y1 = Math.min(height, Math.round(place.y + place.h));
  if (x1 <= x0 || y1 <= y0) return out;
  // 模板坐标映射：放置框 → 模板像素（双线性）
  const rx = tplW / place.w;
  const ry = tplH / place.h;
  const sampleTpl = (fx, fy) => {
    const cx = Math.min(tplW - 1, Math.max(0, fx));
    const cy = Math.min(tplH - 1, Math.max(0, fy));
    const x0i = Math.floor(cx), y0i = Math.floor(cy);
    const x1i = Math.min(tplW - 1, x0i + 1), y1i = Math.min(tplH - 1, y0i + 1);
    const tx = cx - x0i, ty = cy - y0i;
    const i00 = (y0i * tplW + x0i) * 4, i01 = (y0i * tplW + x1i) * 4;
    const i10 = (y1i * tplW + x0i) * 4, i11 = (y1i * tplW + x1i) * 4;
    const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty, w11 = tx * ty;
    return {
      r: tpl[i00] * w00 + tpl[i01] * w01 + tpl[i10] * w10 + tpl[i11] * w11,
      g: tpl[i00 + 1] * w00 + tpl[i01 + 1] * w01 + tpl[i10 + 1] * w10 + tpl[i11 + 1] * w11,
      b: tpl[i00 + 2] * w00 + tpl[i01 + 2] * w01 + tpl[i10 + 2] * w10 + tpl[i11 + 2] * w11,
      a: tpl[i00 + 3] * w00 + tpl[i01 + 3] * w01 + tpl[i10 + 3] * w10 + tpl[i11 + 3] * w11,
    };
  };
  for (let y = y0; y < y1; y++) {
    const fy = (y - place.y + 0.5) * ry - 0.5;
    for (let x = x0; x < x1; x++) {
      const di = y * width + x;
      if (alpha[di] <= 0.5) continue; // 只贴人体区域
      const fx = (x - place.x + 0.5) * rx - 0.5;
      const t = sampleTpl(fx, fy);
      const ta = t.a / 255;
      if (ta <= 0.001) continue; // 模板透明处不覆盖
      const di4 = di * 4;
      // alpha 加权混合：避免半透明边界把背景黑色渗进前景
      const inv = 1 - ta;
      out[di4] = t.r * ta + out[di4] * inv;
      out[di4 + 1] = t.g * ta + out[di4 + 1] * inv;
      out[di4 + 2] = t.b * ta + out[di4 + 2] * inv;
    }
  }
  return out;
}

module.exports = { alphaBBox, suitPlacement, suitCompose };
