'use strict';
// 手动修补 alpha（PRD B1 / T1-17）：用户笔刷涂改修正抠图边缘。
//
// 背景：端侧/云端抠图在发丝、半透明、复杂背景处易留瑕疵（误留背景碎片、误切头发/衣领）。
// PRD B1 要求：当边缘置信度 < 0.85 时，除提示重拍外，还应提供「手动修补工具」让用户自己涂改修正。
//
// 契约（与 matting.js 一致）：alpha 为长度 w*h 的数组，取值 0..1（0=完全背景，1=完全前景）。
// 本模块只动 alpha 通道，不改 RGB；修正后的 alpha 交回 composite() 重新合成底色即可。
//
// 笔刷模式：
//   'erase'   —— 置 0：去掉误留的前景 / 背景残留（把某块从人像里抠掉，或把残留背景抹掉）。
//   'restore' —— 置 1：恢复被误切掉的人体 / 头发（把某块补回人像）。
//
// 设计要点：
//   - 笔画 = 一串归一化坐标点（x,y ∈ [0,1]，相对工作画布宽高），UI 层采集。
//   - 相邻点之间按笔刷半径线性插值落点，避免快速笔触出现断点空洞。
//   - 纯函数、确定性（无随机、无 feathered 软边），便于 Node 单测逐像素断言。

// 把单点笔触盖到 alpha 上（圆形印章，含边界 clamp）
function stamp(out, w, h, nx, ny, rPx, val) {
  const cx = nx * w;
  const cy = ny * h;
  const x0 = Math.max(0, Math.floor(cx - rPx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rPx));
  const y0 = Math.max(0, Math.floor(cy - rPx));
  const y1 = Math.min(h - 1, Math.ceil(cy + rPx));
  const r2 = rPx * rPx;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) out[y * w + x] = val;
    }
  }
}

/**
 * 在 alpha 上应用一组笔画。
 * @param {number[]|Uint8ClampedArray|Float32Array} alpha 原 alpha（0..1），长度 w*h
 * @param {number} w 工作画布宽
 * @param {number} h 工作画布高
 * @param {Array<{mode:'erase'|'restore',radius?:number,points:Array<{x:number,y:number}>}>} strokes 笔画数组（归一化坐标）
 * @param {{clone?:boolean}} [opts]
 * @returns {Uint8ClampedArray} 修正后的 alpha（有笔画时返回新数组，不污染入参）
 */
function applyPatches(alpha, w, h, strokes, opts = {}) {
  if (!alpha || !w || !h) return alpha;
  // 克隆时保留数值表示：真实 matting 的 alpha 是 Float32Array（0..1 浮点），
  // 若用 Uint8ClampedArray 拷贝会把 0.5→0、0.9→1，破坏半透明边缘。
  let out;
  if (alpha instanceof Float32Array) out = new Float32Array(alpha);
  else if (alpha instanceof Uint8ClampedArray) out = new Uint8ClampedArray(alpha);
  else if (alpha instanceof Uint8Array) out = new Uint8ClampedArray(alpha);
  else out = (alpha && alpha.slice) ? alpha.slice() : new Float32Array(alpha);
  if (!strokes || !strokes.length) return out;

  const minEdge = Math.min(w, h);
  for (const s of strokes) {
    if (!s || !s.points || s.points.length === 0) continue;
    const radiusNorm = (typeof s.radius === 'number' && s.radius > 0) ? s.radius : 0.04;
    const rPx = Math.max(1, Math.round(radiusNorm * minEdge));
    const val = s.mode === 'restore' ? 1 : 0;

    // 沿相邻点连线插值落点（步长 ≤ 半径一半，保证连续不空洞）
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i];
      const prev = s.points[i - 1];
      const start = prev || p;
      const segLenNorm = prev ? Math.hypot(p.x - start.x, p.y - start.y) : 0;
      const steps = prev ? Math.max(1, Math.ceil((segLenNorm * minEdge) / (rPx * 0.5))) : 1;
      for (let t = 0; t <= steps; t++) {
        const f = steps === 0 ? 0 : t / steps;
        const nx = start.x + (p.x - start.x) * f;
        const ny = start.y + (p.y - start.y) * f;
        stamp(out, w, h, nx, ny, rPx, val);
      }
    }
  }
  return out;
}

// 新建一条笔画（UI 采集用）
function newStroke(mode, radius, point) {
  return { mode, radius, points: [point] };
}

// 向已有笔画追加一个点（返回同一引用，便于 reducer 风格）
function addPoint(stroke, point) {
  if (!stroke || !stroke.points) return stroke;
  stroke.points.push(point);
  return stroke;
}

// 计算笔画集合影响的像素包围盒（归一化，用于重合成时只刷新局部；UI 暂未用，预留）
function boundsOfStrokes(strokes) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const s of (strokes || [])) {
    for (const p of (s.points || [])) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

module.exports = { applyPatches, newStroke, addPoint, boundsOfStrokes, stamp };
