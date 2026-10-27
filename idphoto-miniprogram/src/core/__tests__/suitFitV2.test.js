'use strict';
// suitFitV2 几何引擎契约单测（P1 / 台账 #73；方案《T3换装重新选型与重构方案》4.2 验收契约）
//
// 与 v1（suitGeometry.test.js）的差别：v1 测的是「猜出来的框别太离谱」，
// 本文件测的是**契约**——信号来源可分层、实测优先、限位生效、非目标构图明确拒绝、
// 9 个规格逐一参数化（不靠目测）。每条用例对应方案 4.2 的一条契约编号。

const test = require('node:test');
const assert = require('node:assert');
const {
  fitSuitV2, checkComposition, shoulderPair, TEMPLATE_META, REASON,
  SCALE_MIN, SCALE_MAX, ROTATE_LIMIT_DEG, CHIN_TO_SUIT_TOP_RATIO, POSE_MIN_SCORE,
} = require('../suitFitV2');
const { SPECS, getPixelSize, DPI_STD } = require('../specLibrary');

// 构造标准证件照画布上的「脸 + 双肩」信号（坐标 = 工作画布像素）
// 头顶留白 0.13×头长（与 core/headCrop.js 同口径），头长 = 规格占比中值 × 画布高
function makeSignals(spec, dpi = DPI_STD, opts = {}) {
  const px = getPixelSize(spec, dpi);
  const ratioMid = (spec.headHeightRatioMin + spec.headHeightRatioMax) / 2;
  const headH = px.height * ratioMid;
  const crownY = 0.13 * headH;
  const chinY = crownY + headH;
  const face = opts.noFace ? null : {
    chinY,
    crownY,
    headH,
    faceCenterX: px.width / 2,
    source: opts.faceSource || 'landmarks',
  };
  // 双肩：肩宽 = 1.6×头长（人体测量学基准），肩线中点位于下巴下方 0.25 头长（解剖常见值）
  const span = 1.6 * headH;
  const shoulderY = chinY + 0.25 * headH;
  const tiltDeg = opts.tiltDeg || 0;
  const rad = (tiltDeg * Math.PI) / 180;
  const cx = px.width / 2;
  const half = span / 2;
  const pose = opts.noPose ? null : {
    points: [
      { name: 'left_shoulder', x: cx - half * Math.cos(rad), y: shoulderY - half * Math.sin(rad), score: opts.scoreL != null ? opts.scoreL : 0.9 },
      { name: 'right_shoulder', x: cx + half * Math.cos(rad), y: shoulderY + half * Math.sin(rad), score: opts.scoreR != null ? opts.scoreR : 0.9 },
      { name: 'nose', x: cx, y: chinY - 0.45 * headH, score: 0.9 },
    ],
  };
  const bbox = opts.noBbox ? null : {
    x: px.width * 0.1, y: crownY, w: px.width * 0.8, h: px.height - crownY,
  };
  return { px, headH, crownY, chinY, face, pose, bbox, span, shoulderY };
}

// ---------- 契约 1：双肩实测 → 肩线夹角即旋转角（±15° 限位） ----------

test('契约1 pose 通道：肩线 8° → rotateDeg≈8，source=pose', () => {
  const spec = SPECS[0]; // 一寸
  const s = makeSignals(spec, DPI_STD, { tiltDeg: 8 });
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: s.pose, bbox: s.bbox });
  assert.ok(r.ok, '应成功：' + JSON.stringify(r.audit));
  assert.strictEqual(r.source, 'pose');
  assert.ok(Math.abs(r.rotateDeg - 8) < 0.01, `rotateDeg 应≈8（实际 ${r.rotateDeg}）`);
  assert.strictEqual(r.basis.shoulder, 'pose');
  assert.ok(!r.warnings.some((w) => w.startsWith('neck_signal_deviation')),
    '标准构图（肩线在下巴下 0.25 头长）不应误报颈根漂移：' + r.warnings.join(','));
});

test('契约1 旋转限位：肩线 30° → 限位到 15° 并 WARN', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD, { tiltDeg: 30 });
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: s.pose, bbox: s.bbox });
  assert.ok(r.ok);
  assert.strictEqual(r.rotateDeg, ROTATE_LIMIT_DEG, '应限位到 +15°');
  assert.ok(r.warnings.some((w) => w.startsWith('rotate_limited')), '应记录 rotate_limited');
});

test('契约1 单肩不可见（score<0.5）→ 不猜对称，回落 face 通道', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD, { tiltDeg: 8, scoreR: 0.2 });
  assert.strictEqual(shoulderPair(s.pose.points), null, '右肩低分 → pose 通道整体不可用');
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: s.pose, bbox: s.bbox });
  assert.ok(r.ok);
  assert.strictEqual(r.source, 'face', '应回落 face（不是 pose）');
  assert.strictEqual(r.basis.shoulder, 'physical', '肩宽走物理标尺');
  assert.strictEqual(r.rotateDeg, 0, '无实测肩线不旋转');
});

// ---------- 契约 2：物理标尺 + 缩放限位 ----------

test('契约2 缩放限位：肩宽过小/过大 → 限位 0.6 / 1.8 并 WARN', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD);
  const fake = (spanPx) => ({
    points: [
      { name: 'left_shoulder', x: s.px.width / 2 - spanPx / 2, y: s.shoulderY, score: 0.9 },
      { name: 'right_shoulder', x: s.px.width / 2 + spanPx / 2, y: s.shoulderY, score: 0.9 },
    ],
  });
  const tiny = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: fake(TEMPLATE_META.shoulderWidthPx * 0.1) });
  assert.ok(Math.abs(tiny.scale - SCALE_MIN) < 1e-9, `极小肩宽应限位到 ${SCALE_MIN}（实际 ${tiny.scale}）`);
  assert.ok(tiny.warnings.some((w) => w.startsWith('scale_limited')));
  const huge = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: fake(TEMPLATE_META.shoulderWidthPx * 5) });
  assert.ok(huge.warnings.some((w) => w.startsWith('scale_limited')), '超大肩宽应触发限位告警');
  assert.ok(huge.scale <= SCALE_MAX + 1e-9, '缩放不得超过上限');
});

test('契约2 物理标尺通道：无 pose 时肩宽 = 1.6×头长，source=face', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD, { noPose: true });
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: null, bbox: s.bbox });
  assert.ok(r.ok);
  assert.strictEqual(r.source, 'face');
  assert.strictEqual(r.basis.shoulder, 'physical');
  assert.ok(Math.abs(r.audit.shoulderSpanPhys - 1.6 * s.headH) < 1e-6, '物理肩宽 = 1.6×头长');
});

// ---------- 契约 3：chinY 锚定 + 颈根双信号偏差告警 ----------

test('契约3 西装顶端 = 下巴 + 0.10×头长（不盖脸，与 headH 来源无关）', () => {
  const spec = SPECS[0];
  for (const faceSource of ['landmarks', 'estimate']) {
    const s = makeSignals(spec, DPI_STD, { faceSource, noPose: true });
    const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: null, bbox: s.bbox });
    assert.ok(r.ok);
    assert.ok(Math.abs(r.audit.garmentTop - (s.chinY + CHIN_TO_SUIT_TOP_RATIO * s.headH)) < 1e-6,
      `${faceSource}: 衣领顶应 = chinY + 0.10×headH（实际 ${r.audit.garmentTop}）`);
    assert.ok(r.audit.garmentTop > s.chinY, '衣领顶必须严格在下巴之下（不盖脸）');
  }
});

test('契约3 颈根偏差：pose 肩线与 chinY 口径差 > 0.15×headH → WARN 并偏向 chinY', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD);
  // 把 pose 肩线人为抬高到下巴上方（模拟 pose 漂移）
  const drifted = {
    points: [
      { name: 'left_shoulder', x: s.px.width / 2 - 100, y: s.chinY - 0.3 * s.headH, score: 0.9 },
      { name: 'right_shoulder', x: s.px.width / 2 + 100, y: s.chinY - 0.3 * s.headH, score: 0.9 },
    ],
  };
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: drifted, bbox: s.bbox });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.startsWith('neck_signal_deviation')), '应记录颈根偏差告警');
  assert.ok(Math.abs(r.audit.garmentTop - (s.chinY + CHIN_TO_SUIT_TOP_RATIO * s.headH)) < 1e-6,
    '偏差时仍以 chinY 为准（脸信号优先，PRD D2）');
});

// ---------- 契约 4：source 分层（四条路径各自可辨识） ----------

test('契约4 source 分层：pose / face / estimate / physical 四态', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD);
  const base = { spec, canvasW: s.px.width, canvasH: s.px.height };
  assert.strictEqual(fitSuitV2({ ...base, face: s.face, pose: s.pose, bbox: s.bbox }).source, 'pose');
  assert.strictEqual(fitSuitV2({ ...base, face: s.face, pose: null, bbox: s.bbox }).source, 'face');
  assert.strictEqual(fitSuitV2({ ...base, face: { ...s.face, source: 'estimate' }, pose: null, bbox: s.bbox }).source, 'estimate');
  assert.strictEqual(fitSuitV2({ ...base, face: null, pose: null, bbox: s.bbox }).source, 'physical');
});

// ---------- 契约 5：输入缺失 → 明确原因码，禁止静默默认值 ----------

test('契约5 缺 spec → suit:no_spec（R1：换装必须锚定规格）', () => {
  const s = makeSignals(SPECS[0], DPI_STD);
  const r = fitSuitV2({ spec: null, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: s.pose });
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, REASON.NO_SPEC);
  assert.ok(r.message.length > 0, '失败必须带可读原因');
});

test('契约5 画布非法 → suit:invalid_canvas', () => {
  const s = makeSignals(SPECS[0], DPI_STD);
  const r = fitSuitV2({ spec: SPECS[0], canvasW: 0, canvasH: s.px.height, face: s.face, pose: s.pose });
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, REASON.BAD_CANVAS);
});

test('契约5 模板元数据缺失 → suit:no_template', () => {
  const s = makeSignals(SPECS[0], DPI_STD);
  const r = fitSuitV2({
    spec: SPECS[0], canvasW: s.px.width, canvasH: s.px.height,
    face: s.face, pose: s.pose, template: { width: 0, height: 0, shoulderWidthPx: 0, collarTopY: 0 },
  });
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, REASON.NO_TEMPLATE);
});

// ---------- 契约 6：9 规格参数化回归（不靠目测） ----------

test('契约6 九规格参数化：西装落在画布内 / 不盖脸 / 旋转在限位内', () => {
  assert.strictEqual(SPECS.length, 9, '规格库应为 9 个规格（R1 范围）');
  for (const spec of SPECS) {
    for (const dpi of [DPI_STD, 600]) {
      const s = makeSignals(spec, dpi);
      const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: s.pose, bbox: s.bbox });
      assert.ok(r.ok, `${spec.id}@${dpi} 应成功：${JSON.stringify(r.audit)}`);
      const p = r.place;
      // ① 左右不越界（x 方向完整落在画布内）
      assert.ok(p.x >= -1e-6 && p.x + p.w <= s.px.width + 1e-6,
        `${spec.id}@${dpi} 西装横向越界：x=${p.x} w=${p.w} canvasW=${s.px.width}`);
      // ② 不盖脸：衣领顶严格在下巴之下
      assert.ok(r.audit.garmentTop > s.chinY,
        `${spec.id}@${dpi} 盖脸：garmentTop=${r.audit.garmentTop} chinY=${s.chinY}`);
      // ③ 旋转限位内
      assert.ok(Math.abs(r.rotateDeg) <= ROTATE_LIMIT_DEG + 1e-9, `${spec.id}@${dpi} 旋转越限`);
      // ④ 比例未被破坏（放置框保持模板宽高比，防 v1 的压扁/拉长）
      const ratio = p.w / p.h;
      const tplRatio = TEMPLATE_META.width / TEMPLATE_META.height;
      assert.ok(Math.abs(ratio - tplRatio) < 1e-6, `${spec.id}@${dpi} 放置框比例失真`);
      // ⑤ 覆盖画布底部（防原衣外露：西装底必须到底，允许下摆出画）
      assert.ok(r.audit.bottomOverflowPx > 0 || Math.abs(p.y + p.h - s.px.height) < 1e-6,
        `${spec.id}@${dpi} 西装未覆盖到画布底`);
      // ⑥ 缩放合法
      assert.ok(r.scale >= SCALE_MIN - 1e-9 && r.scale <= SCALE_MAX + 1e-9, `${spec.id}@${dpi} 缩放越限`);
    }
  }
});

// ---------- 契约 7：非目标构图明确拒绝 ----------

test('契约7 无任何信号 → suit:unsupported_composition，不猜着摆', () => {
  const c = checkComposition({ face: null, pose: null, bbox: null });
  assert.ok(!c.ok);
  assert.strictEqual(c.reason, REASON.UNSUPPORTED);
  assert.ok(c.message.includes('证件照'), '提示要说明改用标准证件照');
});

test('契约7 有人脸 / 有双肩 / 有人像框任一 → 允许（不误杀）', () => {
  const s = makeSignals(SPECS[0], DPI_STD);
  assert.ok(checkComposition({ face: s.face, pose: null, bbox: null }).ok);
  assert.ok(checkComposition({ face: null, pose: s.pose, bbox: null }).ok);
  assert.ok(checkComposition({ face: null, pose: null, bbox: s.bbox }).ok);
});

test('契约7 有 bbox 但无脸无 pose → 走 physical 通道仍可出图（并标记 source）', () => {
  const spec = SPECS[0];
  const s = makeSignals(spec, DPI_STD, { noFace: true, noPose: true });
  const c = checkComposition({ face: null, pose: null, bbox: s.bbox });
  assert.ok(c.ok, '有人像框不算非目标构图');
  const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: null, pose: null, bbox: s.bbox });
  assert.ok(r.ok);
  assert.strictEqual(r.source, 'physical');
  assert.ok(r.place.x >= 0 && r.place.x + r.place.w <= s.px.width + 1e-6, '物理通道也不能越界');
});

// ---------- 与 v1 的关键差异回归（#69 缺陷不复发） ----------

test('#69 回归：estimate 路径（模拟器无 faceDetect）也不得盖脸', () => {
  for (const spec of SPECS) {
    const s = makeSignals(spec, DPI_STD, { faceSource: 'estimate', noPose: true });
    const r = fitSuitV2({ spec, canvasW: s.px.width, canvasH: s.px.height, face: s.face, pose: null, bbox: s.bbox });
    assert.ok(r.ok);
    assert.ok(r.audit.garmentTop > s.chinY,
      `${spec.id} estimate 路径盖脸（v1 必现缺陷）：${r.audit.garmentTop} vs ${s.chinY}`);
    assert.strictEqual(r.source, 'estimate', 'source 应如实标记 estimate（供分层统计）');
  }
});
