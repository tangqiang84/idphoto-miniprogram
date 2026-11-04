'use strict';
const { buildConsentRecord } = require('./privacy');
let serial = 0;
function createConsentSession(tool) {
  let granted = []; let version = 0; let disposed = false;
  const permits = (action = 'local') => !disposed && buildConsentRecord(tool, granted, action).ready;
  function capture(action = 'local') {
    const epoch = version; const traceId = `consent-${Date.now()}-${++serial}`;
    const current = () => !disposed && epoch === version && permits(action);
    const check = () => { if (!current()) throw { code: 'CONSENT_REVOKED', message: '授权不足或已变化，请重新确认后操作', traceId }; };
    return { traceId, current, check, async call(fn) { check(); const value = await fn(); check(); return value; } };
  }
  return { permits, capture, getGranted: () => [...granted],
    update(next) { const normalized = [...new Set(next)].sort(); if (JSON.stringify(normalized) === JSON.stringify(granted)) return false; granted = normalized; version++; return true; },
    dispose() { disposed = true; version++; granted = []; } };
}
module.exports = { createConsentSession };
