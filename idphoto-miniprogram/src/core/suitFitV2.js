'use strict';
// 换装几何引擎 v2（P1 / 台账 #73）—— 实测信号驱动，替代 v1 的「猜测信号」
//
// 【为什么重写】四轮失败的共同结构：v1（core/suit.js 的 suitPlacement）问的是
//「bbox 有多大、行宽在哪突变」，答案是**猜**的；v2 问「肩膀的点的坐标是多少」，答案是**测**的。
//  · #69 西装盖脸：0.85×headH 与 estimate 的 0.30×bbox.h 系数口径不匹配 → v2 一律用 chinY 锚定 + 实测肩宽；
//  · 系数修不完：v1 每轮都在猜的公式上调系数（0.85→chinY、行宽 1.6 倍、0.3），真机上信号质量一变就失效。
// 本模块是**纯函数**（无平台依赖、Node 可单测），所有口径写进注释，跨模块喂参前可对齐（#69 教训 2）。
//
// 【R1 范围约束（owner 2026-10-27）】换装只针对 specLibrary 现有 9 个标准规格的证件照画布。
//   → 目标画布物理尺寸已知（mm）+ 规格头身占比区间已知 → 西装尺寸有**物理标尺**可推导，
//     pose 实测信号只做校准（双通道，不再单靠猜系数）；
//   → 非标准构图（全身/多人/横图/无人脸且无 pose）**明确拒绝 + 原因码**，不猜着摆（契约 7）。
//
// 【三级信号（与 services/poseService.ts 的分层一一对应）】
//   L1 pose  ：云函数 posekey 的实测双肩点（source='pose'）
//   L2 face  ：faceDetect 关键点实测 chinY/headH，肩宽走物理标尺（source='face'）
//   L3 est   ：几何估算（bbox 比例），仅兜底，肩宽走物理标尺（source='estimate'）
//   物理通道：连脸信号都没有时，用「规格头身比 × 画布高」纯推导（source='physical'）
//   四条路径**同权**：都进单测、都进批量验收、都按 source 分层统计（#74 纪律）。

// ---------- 常量（口径集中定义，禁止散落硬编码） ----------

// pose 关键点可用门槛（可见性分数）。MoveNet 输出的 score 为 0~1 置信度。
const POSE_MIN_SCORE = 0.5;

// 肩宽（两肩峰水平距离）÷ 头长（头顶→下巴）的人体测量学工程值。
// 依据：成人肩宽 ≈ 2 个头宽，头宽 ≈ 0.75~0.8 头长 → 肩宽 ≈ 1.5~1.6 头长。
// 用途：**物理标尺通道**的基准（无 pose 实测时），并作为 pose 实测值的合理性参照。
// 【标注为工程近似值】个体/着装（垫肩、大衣）会偏，故 pose 实测存在时以实测为准。
const SHOULDER_HEAD_RATIO = 1.6;

// 模板缩放限位（相对模板原尺寸的倍率）。
// 下限 0.6：再小就盖不住肩；上限 1.8：再大就是「衣服比人大」的明显失真。
const SCALE_MIN = 0.6;
const SCALE_MAX = 1.8;

// 模板旋转限位（度）。肩线倾斜超过 ±15° 基本不是证件照构图（歪头/侧身），
// 强行跟随会出怪图，故限位后按限位值出图 + WARN。
const ROTATE_LIMIT_DEG = 15;

// 西装顶端 = 下巴 + 该比例 × 头长（#69 修复口径：脖子根）。
// 与 headH 的来源解耦（landmarks/estimate/physical 都成立），不再用会冲过下巴的 0.85×headH。
const CHIN_TO_SUIT_TOP_RATIO = 0.10;

// 颈根双信号（chinY 推导值 vs pose 肩线中点）偏差告警阈值（倍头长）。
// 超过 → 记 WARN 并**偏向 chinY**（脸信号优先，PRD D2 合规：不碰脸）。
const NECK_DEVIATION_WARN_RATIO = 0.15;
// 解剖期望值：下巴 → 肩线（肩峰连线）中点的距离（倍头长）。
// 脖子长约 0.15 头长、肩峰略低于颈根 → 实测常见 0.20~0.30，取 0.22 为中值。
// 用途：判断 pose 肩线是否落在合理颈根带（漂移到脸部/腰部即告警）。
const NECK_FROM_CHIN_EXPECT = 0.22;

// pose 实测肩宽与物理标尺肩宽的偏差告警阈值（相对比例）。
const SHOULDER_DEVIATION_WARN = 0.30;

// 自绘模板的几何元数据（SSOT：与 工具链/make_suit_templates.py 的绘制坐标一一对应）。
// 坐标系 = 模板图像自身像素（400×400），y 向下。
//   shoulderWidthPx：肩部最宽处（y=120）两肩端点水平距离 = 380−20 = 360
//   collarTopY     ：衣身/领口顶端 y = 40（模板 y<40 为透明，故放置时必须按此值上提）
//   collarVy       ：V 领尖 y = 152（衬衫三角顶点）
// 三套模板（黑/深蓝/灰）几何完全相同，仅配色不同 → 共用一份元数据。
// 【F2 素材寻源后】换素材时只改这里（+ 绘制脚本），引擎与页面不动。
const TEMPLATE_META = {
  width: 400,
  height: 400,
  shoulderWidthPx: 360,
  shoulderY: 120,
  collarTopY: 40,
  collarVy: 152,
};

// 失败原因码（#67 纪律 6：UI 失败提示必须带原因码，否则现场无法定位）
const REASON = {
  NO_SPEC: 'suit:no_spec',                             // R1：换装必须锚定规格画布
  BAD_CANVAS: 'suit:invalid_canvas',                   // 画布尺寸非法
  NO_TEMPLATE: 'suit:no_template',                     // 缺模板元数据
  UNSUPPORTED: 'suit:unsupported_composition',        // 契约 7：非目标构图，明确拒绝
};

// ---------- 工具 ----------

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// 取 pose 关键点（按名字），并校验可见性分数
function pickPoint(points, name) {
  if (!Array.isArray(points)) return null;
  for (const p of points) {
    if (!p || p.name !== name) continue;
    const x = num(p.x);
    const y = num(p.y);
    if (x === null || y === null) continue;
    const score = typeof p.score === 'number' && isFinite(p.score) ? p.score : 1;
    return { x, y, score };
  }
  return null;
}

// 双肩实测（两点都可见才成立）—— 缺一边就整条 pose 通道不可用（禁止拿单点猜对称）
function shoulderPair(points) {
  const l = pickPoint(points, 'left_shoulder');
  const r = pickPoint(points, 'right_shoulder');
  if (!l || !r) return null;
  if (l.score < POSE_MIN_SCORE || r.score < POSE_MIN_SCORE) return null;
  return { l, r };
}

/**
 * 换装几何求解（纯函数）。
 *
 * @param {object} p
 * @param {object} p.spec       规格对象（specLibrary 的 getSpec 结果；R1 必填）
 * @param {number} p.canvasW    工作画布宽（px）
 * @param {number} p.canvasH    工作画布高（px）
 * @param {object|null} p.face  头部度量 { chinY, headH, crownY, faceCenterX, source }
 *                              source: 'landmarks'(L2) | 'estimate'(L3)
 * @param {object|null} p.pose  pose 结果 { points:[{name,x,y,score}] }（坐标 = 工作画布像素坐标系）
 * @param {object|null} p.bbox  人像包围盒 {x,y,w,h}（L3 兜底用）
 * @param {object} [p.template] 模板元数据（默认 TEMPLATE_META）
 * @returns {{ok:true, place:{x,y,w,h}, rotateDeg:number, scale:number, source:string, basis:object,
 *            warnings:string[], audit:object, reason:null, message:string} |
 *           {ok:false, reason:string, message:string, audit:object}}
 */
function fitSuitV2(p = {}) {
  const { spec, canvasW, canvasH, face, pose, bbox } = p;
  const tpl = p.template || TEMPLATE_META;
  const warnings = [];

  // ---- 0. 入参闸门（缺任一项都不猜，直接给原因码；#70 教训：静默用默认值比失败更坏） ----
  if (!spec || typeof spec.headHeightRatioMin !== 'number' || typeof spec.headHeightRatioMax !== 'number') {
    return fail(REASON.NO_SPEC, '换装需要目标规格（R1：只支持标准证件照规格画布）', { spec: spec ? spec.id : null });
  }
  const cw = num(canvasW);
  const ch = num(canvasH);
  if (!(cw > 0) || !(ch > 0)) {
    return fail(REASON.BAD_CANVAS, '画布尺寸非法', { canvasW, canvasH });
  }
  if (!(tpl.width > 0) || !(tpl.height > 0) || !(tpl.shoulderWidthPx > 0)) {
    return fail(REASON.NO_TEMPLATE, '模板元数据缺失（shoulderWidthPx/collarTopY）', { tpl });
  }

  // ---- 1. 头长 headH：实测优先，其次物理标尺 ----
  const ratioMid = (spec.headHeightRatioMin + spec.headHeightRatioMax) / 2;
  const headHPhys = ch * ratioMid; // 物理标尺：规格头身比区间中值 × 画布高
  let headH = null;
  let headBasis = 'physical';
  const faceHeadH = face ? num(face.headH) : null;
  if (faceHeadH !== null && faceHeadH > 0) {
    headH = faceHeadH;
    headBasis = face && face.source === 'landmarks' ? 'landmarks' : 'estimate';
  }

  // ---- 2. 下巴 chinY 与头顶 crownY ----
  // 三者优先级：face 实测 > 物理标尺（头顶留白 0.13 头长，与 core/headCrop 同口径）
  const TOP_GAP = 0.13; // 与 core/headCrop.js HEAD_TOP_GAP_RATIO 一致（证件照头顶留白）
  let chinY = face ? num(face.chinY) : null;
  let crownY = face ? num(face.crownY) : null;
  if (chinY === null || crownY === null) {
    // 物理标尺：头顶 = 留白下方；下巴 = 头顶 + 头长
    const hPhys = headH !== null ? headH : headHPhys;
    if (chinY === null) chinY = TOP_GAP * hPhys + hPhys;
    if (crownY === null) crownY = chinY - hPhys;
    headBasis = headBasis === 'physical' ? 'physical' : headBasis;
  }
  if (headH === null) headH = Math.max(1, chinY - crownY) > 0 ? chinY - crownY : headHPhys;
  if (!(headH > 0)) {
    return fail(REASON.UNSUPPORTED, '头长测量失败，无法定位换装（请换一张正面标准证件照）', { chinY, crownY });
  }

  // ---- 3. 肩宽：pose 实测优先，物理标尺兜底（双通道） ----
  const sh = shoulderPair(pose && pose.points);
  const shoulderSpanPhys = SHOULDER_HEAD_RATIO * headH;
  let shoulderSpan = shoulderSpanPhys;
  let shoulderBasis = 'physical';
  let shoulderMidX = null;
  let shoulderMidY = null;
  let rotateDeg = 0;
  let source = face
    ? (face.source === 'landmarks' ? 'face' : 'estimate')
    : 'physical';

  if (sh) {
    shoulderSpan = Math.abs(sh.r.x - sh.l.x);
    shoulderMidX = (sh.l.x + sh.r.x) / 2;
    shoulderMidY = (sh.l.y + sh.r.y) / 2;
    shoulderBasis = 'pose';
    source = 'pose';
    // 肩线斜率 → 模板旋转（限位 ±15°）
    const dx = sh.r.x - sh.l.x;
    const dy = sh.r.y - sh.l.y;
    const deg = Math.atan2(dy, dx) * (180 / Math.PI);
    rotateDeg = clamp(deg, -ROTATE_LIMIT_DEG, ROTATE_LIMIT_DEG);
    if (Math.abs(deg) > ROTATE_LIMIT_DEG) {
      warnings.push('rotate_limited:' + deg.toFixed(1));
    }
    // 与物理标尺偏差过大 → WARN（可能是 pose 漂移，也可能真是宽肩/垫肩；仍以实测为准）
    if (shoulderSpanPhys > 0) {
      const dev = Math.abs(shoulderSpan - shoulderSpanPhys) / shoulderSpanPhys;
      if (dev > SHOULDER_DEVIATION_WARN) {
        warnings.push('shoulder_deviates_physical:' + dev.toFixed(2));
      }
    }
  }
  if (shoulderMidX === null) {
    if (face && num(face.faceCenterX) !== null) shoulderMidX = face.faceCenterX;
    else if (bbox && num(bbox.x) !== null) shoulderMidX = bbox.x + bbox.w / 2;
    else shoulderMidX = cw / 2;
  }

  // ---- 4. 颈根双信号融合（方案 4.2.3）----
  const suitTopByChin = chinY + CHIN_TO_SUIT_TOP_RATIO * headH; // 基准：下巴 + 0.10 头长
  let neckY = suitTopByChin;
  if (shoulderMidY !== null) {
    // 与「下巴 → 肩线中点」的解剖期望比对：偏离过大说明 pose 肩线漂移（可能漂到脸部或腰部）
    const dev = Math.abs(shoulderMidY - (chinY + NECK_FROM_CHIN_EXPECT * headH)) / headH;
    if (dev > NECK_DEVIATION_WARN_RATIO) {
      warnings.push('neck_signal_deviation:' + dev.toFixed(2));
    }
    // 无论是否告警，颈根**恒取 chinY 推导值**（脸信号优先，PRD D2：绝不因 pose 漂移把衣服往脸上挪）
    neckY = suitTopByChin;
  }

  // ---- 5. 模板缩放：实测肩宽 ÷ 模板肩宽（限位 0.6~1.8）----
  let scale = shoulderSpan / tpl.shoulderWidthPx;
  const rawScale = scale;
  scale = clamp(scale, SCALE_MIN, SCALE_MAX);
  if (Math.abs(scale - rawScale) > 1e-9) warnings.push('scale_limited:' + rawScale.toFixed(2));

  // ---- 6. 放置框 ----
  // 放置框严格保持模板宽高比（绝不单独压/拉某一方向——v1 的变形缺陷就来自比例失真）。
  let w = scale * tpl.width;
  let widthClamped = false;
  if (w > cw) {
    // 证件照构图里肩宽本就常常出画（一寸画布 25mm 宽 ≈ 真实肩宽的 55%），
    // 属常态而非异常 → 只记 audit，不进 warnings（避免刷屏掩盖真异常）。
    w = cw;
    scale = w / tpl.width;
    widthClamped = true;
  }
  const h = scale * tpl.height;
  // 顶端锚定：模板的 collarTopY（衣领顶端）对齐颈根 → 放置框 y 上提该偏移量。
  // 【重要】不能用「模板顶端对齐颈根」——模板上部 collarTopY 是透明区，
  // 那会让衣领落到颈根下方 40/400×h，露出原衣领（#69 第四层根因同源）。
  const collarOffset = tpl.collarTopY * scale;
  const y = neckY - collarOffset;
  // x：以肩线中点居中，左右严格不出画（纵向允许下摆出画——否则强制压缩会变形，
  // 且衬衫/西装下摆出画是证件照常态；合成时由 suitCompose 按画布裁剪）。
  let x = shoulderMidX - w / 2;
  if (x < 0) x = 0;
  if (x + w > cw) x = Math.max(0, cw - w);

  const place = { x, y, w, h };
  const bottomOverflowPx = Math.max(0, y + h - ch);

  // ---- 7. 不盖脸断言（#69 口径：西装衣身顶端必须严格在下巴之下）----
  const garmentTop = y + collarOffset;
  if (garmentTop <= chinY) {
    // 理论上不会触发（neckY = chinY + 0.1×headH）；触发即说明口径被破坏 → 显式失败，不静默出图
    return fail(REASON.UNSUPPORTED, '换装位置会覆盖脸部，已拒绝出图（请换一张标准构图照片）', {
      garmentTop, chinY, headH,
    });
  }

  return {
    ok: true,
    place,
    rotateDeg,
    scale,
    source,
    basis: { head: headBasis, shoulder: shoulderBasis },
    warnings,
    reason: null,
    message: '',
    audit: {
      spec: spec.id,
      canvasW: cw,
      canvasH: ch,
      headH,
      headHPhys,
      chinY,
      crownY,
      shoulderSpan,
      shoulderSpanPhys,
      rotateDeg,
      scale,
      garmentTop,
      widthClamped,
      bottomOverflowPx,
      source,
      basis: { head: headBasis, shoulder: shoulderBasis },
      warnings: warnings.slice(),
    },
  };
}

function fail(reason, message, extra) {
  return {
    ok: false,
    reason,
    message,
    place: null,
    rotateDeg: 0,
    scale: 1,
    source: 'none',
    basis: { head: 'unknown', shoulder: 'unknown' },
    warnings: [],
    audit: Object.assign({ reason, message }, extra || {}),
  };
}

/**
 * 非目标构图判定（契约 7）：连一个可用信号都没有 → 拒绝，不猜着摆。
 * 与 fitSuitV2 分离，便于调用方在跑重链路前先做一次便宜的拦截。
 *
 * @param {object} p { face, pose, bbox }
 * @returns {{ok:boolean, reason:string|null, message:string}}
 */
function checkComposition(p = {}) {
  const { face, pose, bbox } = p;
  const hasFace = !!(face && (num(face.chinY) !== null || num(face.headH) > 0));
  const hasPose = !!shoulderPair(pose && pose.points);
  const hasBbox = !!(bbox && num(bbox.h) > 0 && num(bbox.w) > 0);
  if (hasFace || hasPose || hasBbox) return { ok: true, reason: null, message: '' };
  return {
    ok: false,
    reason: REASON.UNSUPPORTED,
    message: '未检测到人像/双肩，无法换装。请使用正面标准证件照（全身照、多人合照、横图等非证件照构图不支持）',
  };
}

module.exports = {
  fitSuitV2,
  checkComposition,
  shoulderPair,
  TEMPLATE_META,
  REASON,
  // 常量导出供单测与页面审计使用
  POSE_MIN_SCORE,
  SHOULDER_HEAD_RATIO,
  SCALE_MIN,
  SCALE_MAX,
  ROTATE_LIMIT_DEG,
  CHIN_TO_SUIT_TOP_RATIO,
  NECK_DEVIATION_WARN_RATIO,
  NECK_FROM_CHIN_EXPECT,
  SHOULDER_DEVIATION_WARN,
};
