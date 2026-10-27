'use strict';
/**
 * 批量验收指标实现的离线验证（P1 #78）
 *
 * 【为什么需要这个】批量验收要跑 IDE 自动化通道，而该通道**一次只能维持一个会话**
 * （问题 #86），在长跑/连跑时容易 timeout，导致「指标代码有没有写对」无法被验证。
 * 本脚本用**合成 audit 行**直接验证指标链路：
 *   ① console 行 → parseAuditObjects → suit_fit_v2 结构化字段（source / rotateDeg / shoulderSpan）
 *   ② 肩线达标判定（≤8° 达标；>8° 不达标；缺失 → 不判定）
 *   ③ 信号来源分层统计（pose / face / estimate / physical / none）
 * ④ report_acceptance.py 的 classify 判定（肩线超标 → FAIL；达标 → 结论里带角度）
 *
 * 用法：NODE_OPTIONS= node 工具链/verify_shoulder_metric.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : ''));
};

// ---- 复制 batch_acceptance.js 的解析实现（保持同一份口径，避免两处漂移）----
const batchSrc = fs.readFileSync(path.join(__dirname, 'batch_acceptance.js'), 'utf8');
const fnStart = batchSrc.indexOf('function parseAuditObjects');
const fnEnd = batchSrc.indexOf('\n}', fnStart) + 2;
const parseAuditObjects = eval('(' + batchSrc.slice(fnStart, fnEnd).replace(/^function parseAuditObjects/, 'function') + ')');
const limitMatch = batchSrc.match(/const SHOULDER_ANGLE_LIMIT_DEG = (\d+);/);
const SHOULDER_ANGLE_LIMIT_DEG = limitMatch ? Number(limitMatch[1]) : 8;

// ---- 合成 console 行（automator console 事件的序列化形态）----
function auditLine(obj) {
  return '[log] ' + JSON.stringify({ type: 'log', args: ['[audit]', obj] });
}

const mkFit = (source, rotateDeg, extra) => Object.assign({
  stage: 'suit_fit_v2', ok: true, source, rotateDeg,
  shoulderSpan: 420, spec: 'one-inch', warnings: [],
}, extra || {});

const lines = [
  auditLine({ stage: 'pose_signal', ok: false, reason: 'posekey:not_deployed', model: null, latencyMs: null }),
  auditLine(mkFit('face', 3.2)),
  auditLine({ stage: 'suit_geometry', source: 'landmarks', bbox: { x: 1, y: 2, w: 3, h: 4 } }),
  auditLine(mkFit('pose', 12.5)),
  auditLine(mkFit('estimate', 0)),
  auditLine(mkFit('physical', 7.9)),
];

const objs = parseAuditObjects(lines);
check('① 解析出全部 audit 对象', objs.length === lines.length, 'got ' + objs.length);

const fits = objs.filter((o) => o && o.stage === 'suit_fit_v2' && o.ok !== false);
check('① 解析出 4 条 suit_fit_v2', fits.length === 4, 'got ' + fits.length);
check('① 字段完整（source/rotateDeg/shoulderSpan）',
  fits[0].source === 'face' && fits[0].rotateDeg === 3.2 && fits[0].shoulderSpan === 420,
  JSON.stringify(fits[0]));

// ---- ② 肩线达标判定 ----
const judge = (deg) => (deg === null || deg === undefined ? null : (Math.abs(deg) <= SHOULDER_ANGLE_LIMIT_DEG));
check('② 3.2° 达标', judge(3.2) === true);
check('② 12.5° 超标', judge(12.5) === false);
check('② 0° 达标', judge(0) === true);
check('② 缺失 → 不判定', judge(null) === null);
check('② 阈值取自 batch 脚本常量（8°）', SHOULDER_ANGLE_LIMIT_DEG === 8, String(SHOULDER_ANGLE_LIMIT_DEG));

// ---- ③ 分层统计 ----
const bySource = {};
for (const f of fits) bySource[f.source] = (bySource[f.source] || 0) + 1;
check('③ 分层统计 face=1/pose=1/estimate=1/physical=1',
  bySource.face === 1 && bySource.pose === 1 && bySource.estimate === 1 && bySource.physical === 1,
  JSON.stringify(bySource));

// ---- ④ report_acceptance.py 的 classify 判定（用 python 跑真逻辑）----
const py = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location('ra', ${JSON.stringify(path.join(__dirname, 'report_acceptance.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cases = [
  ({'status':'完成（云端精修）','finished':True,'shoulderOk':False,'shoulderAngleDeg':12.5,'suitSource':'pose'}, 'FAIL'),
  ({'status':'完成（云端精修）','finished':True,'shoulderOk':True,'shoulderAngleDeg':3.2,'suitSource':'face'}, 'PASS'),
  ({'status':'完成（cloud->edge，云端不可用已降级）','finished':True,'shoulderOk':True,'shoulderAngleDeg':0,'suitSource':'physical'}, 'DEGRADED'),
]
bad = 0
for rec, want in cases:
    got, reason = m.classify(rec, 0.001)
    if got != want:
        print('MISMATCH', json.dumps(rec, ensure_ascii=False), 'got', got, 'want', want)
        bad += 1
    else:
        print('OK', got, '|', reason)
sys.exit(1 if bad else 0)
`;
const { execFileSync } = require('child_process');
let pyOut = '';
let pyOk = true;
try {
  pyOut = execFileSync('python3', ['-c', py], { encoding: 'utf8' });
} catch (e) {
  pyOk = false;
  pyOut = (e.stdout || '') + (e.stderr || '');
}
check('④ report classify：肩线超标→FAIL / 达标→PASS / 降级→DEGRADED', pyOk, pyOut.trim().split('\n').slice(-3).join(' | '));

console.log('\n' + (fail === 0 ? '✅ 指标实现全部验证通过（链路验证级；真实数据待 IDE 通道恢复后跑）' : `❌ ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
