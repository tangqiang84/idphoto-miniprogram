'use strict';
// 按规格头部占比反解裁剪框（纯逻辑，可单测；框架无关）
//
// 【为什么要有这个模块】2026-10-23 任务 #24（PRD B2「智能裁切」）。
// 此前 T1 只做「居中裁剪」（core/compose.js 的 planOutput）：裁剪窗按目标宽高比居中，
// 与人脸在画面里的位置无关。于是同一张原片换成不同规格、或用户站位偏移时，
// 成品图的头部占比会随构图漂移 —— 拍得正就合规，人往边上站一点就不合规。
// 本模块把「裁剪框」从「居中」升级为「按该规格的头占比区间反解」。
//
// 【口径约定】（与 core/face.js、core/compliance.js 严格一致）
//   · 头长 = 头顶(含头发) → 下巴（core/face.js 的 headLengthPx）；
//   · 头占比 = 头长 ÷ 成品图高（core/compliance.js 的 headHeightRatio）；
//   · 规格区间来自 core/specLibrary.js 的 headHeightRatioMin/Max（SSOT，不在此处硬编码）。
//
// 【目标占比取「区间中值」】owner 2026-10-23 拍板：
//   目标头占比 R = (ratioMin + ratioMax) / 2。
//   理由：测量本身有误差（头顶位置是外推估算，见官方口径对照表第五章），
//   取中值可让实测值落在区间内时**双向**各留约 5% 余量 ——
//   若直接瞄准区间上/下沿，单向误差就会把合规照推出区间。
//
// 【构图留白的依据】官方口径对照表（2.1 中国护照）：
//   「头顶留白 3~5mm」「下巴至下边 ≥7mm」，护照高 48mm、头长 28~33mm。
//   换算成头长倍数：头顶留白 ≈ 3~5mm / 28~33mm ≈ 0.115~0.15 倍头长；
//   下巴至下边 ≥7mm / 48mm ≈ 0.146 倍图高。
//   本模块据此取：
//     HEAD_TOP_GAP_RATIO = 0.13（头顶上方留白 ≈ 0.13 倍头长）
//     CHIN_BOTTOM_GAP_RATIO = 0.16（下巴下方留白 ≈ 0.16 倍图高）
//   —— 这两个系数是【构图美学参数】（让成品像标准证件照），不是合规判定项；
//      合规判定只看头占比是否落在规格区间内（由 core/compliance.js 负责）。
//
// 【反解数学】
//   设工作图坐标系下，头顶 y = crownY，下巴 y = chinY，头长 headPx = chinY - crownY。
//   裁剪窗 (sx, sy, sw, sh) 从工作图裁出，再缩放到成品 (targetW, targetH)。
//   成品图中的头占比 = （裁剪窗内的可见头长）/ sh   （等比缩放不改变比例）
//   要让占比 = R  ⟺  可见头长 = R × sh
//   若头完全在窗内（不被裁掉），可见头长 = headPx  ⟹  sh = headPx / R
//   宽由目标宽高比决定：sw = sh × (targetW / targetH)
//
// 【为什么窗高不能无限缩小】
//   sh 越小 → 头占比越高，但成品像素要从更小的区域放大 → 画质变差。
//   同时若 sh 小到把下巴或头顶裁掉，可见头长 < headPx，实测占比会偏离目标。
//   故本模块给出【下限保护】：sh 不小于「能完整装下头 + 必要留白」的高度；
//   达不到目标占比时如实标记 degraded + 提示（owner 决策：出图 + 醒目提示，不阻断导出）。

// 头顶上方留白（倍头长）—— 依据官方口径「头顶留白 3~5mm / 头长 28~33mm」
const HEAD_TOP_GAP_RATIO = 0.13;
// 下巴下方留白（倍图高）—— 依据官方口径「下巴至下边 ≥7mm / 图高 48mm」
const CHIN_BOTTOM_GAP_RATIO = 0.16;
// 构图留白占用的额外高度（倍图高）：用于校验「至少能装下头 + 留白」
const MIN_GAP_SUM_RATIO = 0.05;

/**
 * 计算目标头占比（规格区间中值）。
 * @param {number} ratioMin 规格头占比下限（0~1）
 * @param {number} ratioMax 规格头占比上限（0~1）
 * @returns {number|null} 目标占比；参数无效时返回 null
 */
function targetHeadRatio(ratioMin, ratioMax) {
  if (typeof ratioMin !== 'number' || typeof ratioMax !== 'number') return null;
  if (!(ratioMin > 0) || !(ratioMax > 0)) return null;
  if (ratioMax < ratioMin) return null;
  return (ratioMin + ratioMax) / 2;
}

/**
 * 按头占比反解裁剪框。
 *
 * @param {object} p
 * @param {number} p.workW 工作图宽（px）
 * @param {number} p.workH 工作图高（px）
 * @param {number} p.targetW 成品宽（px）
 * @param {number} p.targetH 成品高（px）
 * @param {number} p.crownY 头顶 y（工作图坐标）
 * @param {number} p.chinY 下巴 y（工作图坐标）
 * @param {number} p.faceCenterX 面部水平中心 x（工作图坐标）
 * @param {number} p.ratioMin 规格头占比下限
 * @param {number} p.ratioMax 规格头占比上限
 * @param {number} [p.minVisibleRatio] 头占比下限保护阈值（默认 = 目标占比的 80%）
 * @returns {{
 *   sx:number, sy:number, sw:number, sh:number,
 *   ratioTarget:number, ratioAchieved:number,
 *   degraded:boolean, degradeReason:string|null,
 *   notes:string[],
 *   headFullyVisible:boolean
 * }|null}
 */
function planHeadCrop(p) {
  const {
    workW, workH, targetW, targetH,
    crownY, chinY, faceCenterX,
    ratioMin, ratioMax,
  } = p || {};

  if (!workW || !workH || !targetW || !targetH) return null;
  if (typeof crownY !== 'number' || typeof chinY !== 'number') return null;

  const ratioTarget = targetHeadRatio(ratioMin, ratioMax);
  if (ratioTarget == null) return null;

  const headPx = chinY - crownY;
  if (!(headPx > 0)) return null;

  const notes = [];
  const aspect = targetW / targetH;

  // ---- 1. 由目标占比反解所需窗高 ----
  // 理想值：整头在窗内 ⟹ sh = headPx / R
  let sh = headPx / ratioTarget;
  let sw = sh * aspect;

  // ---- 2. 宽度受工作图限制 ----
  // sw 不能超过 workW（否则裁剪窗出界）。此时按宽度反推 sh：
  // 宽被压缩 → 可见头长不变、窗高变小 → 实测占比高于目标（构图偏紧）。
  let widthLimited = false;
  if (sw > workW) {
    sw = workW;
    sh = sw / aspect;
    widthLimited = true;
  }

  // ---- 3. 高度受工作图限制 ----
  // sh 不能超过 workH。同样会导致实测占比高于目标。
  let heightLimited = false;
  if (sh > workH) {
    sh = workH;
    sw = sh * aspect;
    if (sw > workW) {
      sw = workW;
      sh = sw / aspect;
    }
    heightLimited = true;
  }

  // ---- 4. 垂直定位：头顶上方留白 ----
  // 期望：头顶上方留 topGap = HEAD_TOP_GAP_RATIO × 头长
  const topGap = HEAD_TOP_GAP_RATIO * headPx;
  // 期望：下巴下方留 bottomGap = CHIN_BOTTOM_GAP_RATIO × 窗高
  const bottomGap = CHIN_BOTTOM_GAP_RATIO * sh;
  // 头 + 上下留白所需的最小高度
  const minNeeded = headPx + topGap + bottomGap;

  let sy = crownY - topGap;               // 头顶上方留 topGap
  let headFullyVisible = true;

  if (minNeeded > sh) {
    // 窗高不足以同时容纳「头 + 必要留白」→ 放弃部分留白，把头顶尽量放到窗内
    // 优先级：先保头不被裁（头占比才有意义），再保留白。
    sy = Math.max(0, Math.min(crownY - topGap * 0.5, workH - sh));
  }

  // 窗必须完整落在画面内（【问题台账 #37】bug：crownY<0 时 sy=crownY-topGap 会越出上界，
  //   导致裁剪窗超出原图 → drawImage 取到空白，输出纯色图）。
  // 顺序很重要：先夹到 [0, workH-sh]，再判头顶/下巴是否被裁 —— 否则夹取会掩盖裁切事实。
  sy = Math.max(0, Math.min(sy, workH - sh));

  // 头顶被裁掉了吗？—— 若 sy > crownY，则头顶在窗外
  if (sy > crownY) {
    headFullyVisible = false;
    sy = crownY;                          // 至少把头顶贴在窗顶
  }
  // 下巴被裁掉了吗？—— 若 sy + sh < chinY，则下巴在窗外
  if (sy + sh < chinY) {
    headFullyVisible = false;
    sy = Math.max(0, chinY - sh);         // 至少把下巴贴在窗底
  }
  // 二次夹取：上面的「贴顶/贴底」修正可能再次越界（如头比窗还高）
  sy = Math.max(0, Math.min(sy, workH - sh));

  // ---- 5. 水平定位：面部居中（owner 决策：同时做水平居中）----
  // 面部中心对齐裁剪窗中心；但水平方向没有官方留白口径，
  // 因此不强制留白，只保证「脸在窗内、尽量居中」。
  let sx;
  if (typeof faceCenterX === 'number' && isFinite(faceCenterX)) {
    sx = faceCenterX - sw / 2;
    // 脸不能被切掉：若脸中心离窗边太近（脸宽未知，用保守估计），把脸拉回窗内
    // 保守估计脸宽 = 0.75 × 头长（常见人脸宽/头长比）
    const faceHalf = 0.375 * headPx;
    if (sx + faceHalf > workW) sx = workW - faceHalf - sw / 2;
    if (sx + faceHalf < 0) sx = 0;
  } else {
    sx = (workW - sw) / 2;
  }
  sx = Math.max(0, Math.min(sx, workW - sw));

  // ---- 6. 反算实际可达的头占比 ----
  // 可见头长 = 窗与 [crownY, chinY] 的交集长度
  const visibleTop = Math.max(crownY, sy);
  const visibleBottom = Math.min(chinY, sy + sh);
  const visibleHeadPx = Math.max(0, visibleBottom - visibleTop);
  const ratioAchieved = visibleHeadPx / sh;

  // ---- 7. 降级判定 ----
  // 目标占比在区间内即达标；区间外则如实标记（owner 决策：出图 + 醒目提示，不阻断导出）
  let degraded = false;
  let degradeReason = null;
  if (ratioAchieved < ratioMin - 1e-6) {
    degraded = true;
    degradeReason = 'below-min';
  } else if (ratioAchieved > ratioMax + 1e-6) {
    degraded = true;
    degradeReason = 'above-max';
  }
  if (!headFullyVisible) {
    degraded = true;
    if (!degradeReason) degradeReason = 'head-clipped';
  }

  // ---- 8. 提示文案 ----
  if (widthLimited || heightLimited) {
    notes.push('原片构图偏紧，无法裁到规格要求的头部占比');
  }
  if (!headFullyVisible) {
    notes.push('原片头顶或下巴超出画面，已尽量保留');
  }
  if (degraded && degradeReason === 'below-min') {
    notes.push(`头部占比 ${(ratioAchieved * 100).toFixed(0)}%，低于规格要求的 ${(ratioMin * 100).toFixed(0)}%，建议重新拍摄`);
  }
  if (degraded && degradeReason === 'above-max') {
    notes.push(`头部占比 ${(ratioAchieved * 100).toFixed(0)}%，高于规格要求的 ${(ratioMax * 100).toFixed(0)}%，建议重新拍摄`);
  }

  return {
    sx, sy, sw, sh,
    ratioTarget,
    ratioAchieved,
    degraded,
    degradeReason,
    notes,
    headFullyVisible,
  };
}

module.exports = {
  planHeadCrop,
  targetHeadRatio,
  HEAD_TOP_GAP_RATIO,
  CHIN_BOTTOM_GAP_RATIO,
};
