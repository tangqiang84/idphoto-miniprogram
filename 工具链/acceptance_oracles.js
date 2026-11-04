'use strict';

function beforeCropConfirmation(observation) {
  if (!observation || observation.imageDelivered !== true || !Array.isArray(observation.events)) {
    return { status: 'BLOCKED', reason: '没有合法输入已交给页面的观测证据' };
  }
  const forbidden = observation.events.filter((event) =>
    ['segment', 'beauty', 'suit', 'product-export'].includes(event.kind) && event.cropConfirmed !== true);
  return forbidden.length
    ? { status: 'FAIL', reason: '用户确认裁剪前已进入下游处理', observed: forbidden.map((event) => event.kind) }
    : { status: 'PASS', reason: '本次观测区间未在裁剪确认前调用下游；不证明后续链路正确' };
}

function measuredShoulder(observation) {
  if (!observation || observation.source !== 'pose' || observation.measured !== true) {
    return { status: 'BLOCKED', reason: '估算或缺失信号不能计入实测肩线达标率' };
  }
  if (!Number.isFinite(observation.errorDeg)) return { status: 'BLOCKED', reason: '缺少实测角度误差' };
  return { status: Math.abs(observation.errorDeg) <= 8 ? 'PASS' : 'FAIL', reason: '仅判定实测角度，不证明领口自然度' };
}

function classifySample(observation) {
  if (!observation || typeof observation.expected !== 'string') return { status: 'BLOCKED', category: 'unclassified' };
  if (observation.expected === 'reject') {
    return { status: observation.rejected === true && !!observation.reasonCode ? 'PASS' : 'FAIL', category: 'expected-rejection' };
  }
  if (observation.expected !== 'product') return { status: 'BLOCKED', category: 'unclassified' };
  return { status: observation.artifactChecked === true && observation.businessPass === true ? 'PASS' : 'FAIL', category: 'product' };
}

module.exports = { beforeCropConfirmation, measuredShoulder, classifySample };
