'use strict';
// posekey 云函数契约单测（P1 / 台账 #72；方案 4.1「契约先行」）
// 云函数要部署到 CloudBase 才能真机验证，而契约必须在本地先锁死：
// 出参校验 / 错误码归一 / 坐标换算 / 入参结构 —— 换模型实现（tflite→onnx→阿里云）都不动前端。

const test = require('node:test');
const assert = require('node:assert');
const {
  KEYPOINT_NAMES, REASON, parsePoseResult, mapPoseToCanvas, buildPoseRequest,
} = require('../poseContract');

test('契约：成功返回 → 解析出 17 点并按名字可索引', () => {
  const res = {
    keypoints: KEYPOINT_NAMES.map((name, i) => ({ name, x: 0.5, y: 0.1 * i, score: 0.9 })),
    model: 'movenet-lightning-int8',
    latencyMs: 42,
  };
  const p = parsePoseResult(res);
  assert.ok(p.ok);
  assert.strictEqual(p.points.length, 17);
  assert.strictEqual(p.model, 'movenet-lightning-int8');
  assert.strictEqual(p.latencyMs, 42);
  assert.strictEqual(p.points[5].name, 'left_shoulder');
  assert.strictEqual(p.points[6].name, 'right_shoulder');
});

test('契约：无 name 只有 index → 按 COCO 顺序映射（兼容简化实现）', () => {
  const res = { keypoints: [{ index: 5, x: 0.3, y: 0.4, score: 0.8 }, { index: 6, x: 0.7, y: 0.4, score: 0.8 }] };
  const p = parsePoseResult(res);
  assert.ok(p.ok);
  assert.strictEqual(p.points[0].name, 'left_shoulder');
  assert.strictEqual(p.points[1].name, 'right_shoulder');
});

test('契约：云函数错误码 → 统一 posekey: 前缀原因码（UI 可直接显示）', () => {
  assert.strictEqual(parsePoseResult({ error: 'no_person' }).reason, 'posekey:no_person');
  assert.strictEqual(parsePoseResult({ error: 'not_deployed' }).reason, 'posekey:not_deployed');
  assert.strictEqual(parsePoseResult({ error: 'unknown_thing' }).reason, REASON.CALL_FAILED);
});

test('契约：空返回 / 关键点全空 → no_person（不静默造点）', () => {
  assert.strictEqual(parsePoseResult(null).reason, REASON.BAD_RESULT);
  assert.strictEqual(parsePoseResult({ keypoints: [] }).reason, REASON.NO_PERSON);
  assert.strictEqual(parsePoseResult({ keypoints: [{ x: null, y: 1 }] }).reason, REASON.NO_PERSON);
});

test('契约：score 缺失按 0 处理（引擎侧 0.5 门槛会正确拒绝该点）', () => {
  const p = parsePoseResult({ keypoints: [{ name: 'nose', x: 0.5, y: 0.5 }] });
  assert.ok(p.ok);
  assert.strictEqual(p.points[0].score, 0);
});

test('契约：归一化坐标 → 工作画布像素（上传区域=整画布 与 子区域两种）', () => {
  const pts = [{ name: 'left_shoulder', x: 0.25, y: 0.5, score: 0.9 }];
  const full = mapPoseToCanvas(pts, { x: 0, y: 0, w: 400, h: 600 }, { canvasW: 400, canvasH: 600 });
  assert.strictEqual(full[0].x, 100);
  assert.strictEqual(full[0].y, 300);
  const sub = mapPoseToCanvas(pts, { x: 50, y: 100, w: 200, h: 300 }, { canvasW: 400, canvasH: 600 });
  assert.strictEqual(sub[0].x, 100); // 50 + 0.25×200
  assert.strictEqual(sub[0].y, 250); // 100 + 0.5×300
});

test('契约：坐标越界 → clamp 到画布（防 pose 漂移把西装摆到画外）', () => {
  const pts = [{ name: 'nose', x: 1.4, y: -0.2, score: 1 }];
  const m = mapPoseToCanvas(pts, { x: 0, y: 0, w: 300, h: 400 }, { canvasW: 300, canvasH: 400 });
  assert.strictEqual(m[0].x, 300);
  assert.strictEqual(m[0].y, 0);
});

test('契约：入参结构与 matting 云函数同口径（境内 / 不留存 / 不训练）', () => {
  const req = buildPoseRequest({ imageB64: 'AAA', width: 192, height: 192 });
  assert.strictEqual(req.region, 'CN');
  assert.strictEqual(req.purpose, 'pose_keypoints');
  assert.strictEqual(req.retain, false);
  assert.strictEqual(req.train, false);
  assert.strictEqual(req.width, 192);
});
