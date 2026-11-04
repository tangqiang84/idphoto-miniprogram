'use strict';
const { getPixelSize, getSpec, listSpecs, BG } = require('./specLibrary');
const { resolveBackground } = require('./color');
const { centerCropWindow, clampCropWindow } = require('./cropWindow');
const DEFAULT_BEAUTY = { enabled: false, smooth: 0.35, whiten: 0.3, brighten: 0.2 };
const copy = (value) => JSON.parse(JSON.stringify(value));
let sessionSerial = 0;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function createProcessingSession(options = {}) {
  let serial = 0;
  const sessionId = ++sessionSerial;
  let active = null;
  let disposed = false;
  const listeners = new Set();
  let state = { revision: 0, sourceId: 0, status: 'empty', stage: 'crop', error: null, traceId: null,
    selfChecked: false, output: null, changed: [], params: {
      source: null, specId: listSpecs()[0].id, dpi: 300, bg: 'white',
      beauty: copy(DEFAULT_BEAUTY), suit: { enabled: false, templateId: 'black' },
      consents: [], cropWindow: null, cropConfirmed: false,
      ...(options.tool === 'T5' ? { customTarget: null, kbLimit: 200 } : {}),
    } };
  const snapshot = () => ({ ...state, changed: [...state.changed], params: copy(state.params) });
  const emit = () => { for (const listener of listeners) listener(snapshot()); };
  const error = (code, message, traceId = state.traceId) => ({ code, message, traceId });
  const log = (value) => (options.logger || ((meta) => console.warn('[processing-session]', meta)))(value);
  function stop(code) {
    if (!active) return;
    const old = active; active = null;
    clearTimeout(old.timer);
    old.reject(error(code, '任务已结束，结果不会继续使用', old.traceId));
    for (const cancel of old.cancellers) { try { cancel(); } catch { log({ code: 'SESSION_CANCEL_ADAPTER', traceId: old.traceId }); } }
  }
  function update(change) {
    if (disposed) return { ok: false, error: error('SESSION_DISPOSED', '页面已离开，请重新进入') };
    const allowed = ['customTarget', 'kbLimit', 'source', 'specId', 'dpi', 'bg', 'beauty', 'suit', 'consents', 'cropWindow'];
    if (!change || Object.keys(change).some((key) => !allowed.includes(key))) return { ok: false, error: error('SESSION_PARAM', '会话参数无效') };
    const next = { ...copy(state.params), ...copy(change) };
    if (!getSpec(next.specId) || ![300, 600].includes(next.dpi) || (options.tool === 'T2' ? !BG[next.bg] && resolveBackground(next.bg).type === 'invalid' : !BG[next.bg])
        || (next.customTarget != null && (options.tool !== 'T5' || !['width','height'].every(k => Number.isInteger(next.customTarget[k]) && next.customTarget[k] >= 1 && next.customTarget[k] <= 5000)))
        || (next.kbLimit != null && (!Number.isFinite(next.kbLimit) || next.kbLimit < 0 || next.kbLimit > 20000))
        || !next.beauty || !['smooth', 'whiten', 'brighten'].every((key) => Number.isFinite(next.beauty[key]) && next.beauty[key] >= 0 && next.beauty[key] <= 1)
        || typeof next.beauty.enabled !== 'boolean' || Object.keys(next.beauty).some((key) => !['enabled', 'smooth', 'whiten', 'brighten'].includes(key))
        || !next.suit || typeof next.suit.enabled !== 'boolean' || !['black', 'navy', 'gray'].includes(next.suit.templateId)
        || !Array.isArray(next.consents) || next.consents.some((id) => typeof id !== 'string')
        || (next.source && (!next.source.path || !Number.isFinite(next.source.width) || !Number.isFinite(next.source.height) || next.source.width <= 0 || next.source.height <= 0))) {
      return { ok: false, error: error('SESSION_PARAM', '照片、规格或处理参数无效，请重新选择') };
    }
    const changed = Object.keys(change).filter((key) => key === 'source' || JSON.stringify(state.params[key]) !== JSON.stringify(next[key]));
    if (!changed.length) return { ok: true, state: snapshot() };
    if (changed.includes('source') || changed.includes('specId') || changed.includes('customTarget')) {
      const target = next.customTarget || getPixelSize(next.specId, 300);
      next.cropWindow = next.source ? centerCropWindow(next.source.width, next.source.height, target.width / target.height) : null;
      next.cropConfirmed = false;
    } else if (changed.includes('cropWindow')) {
      const target = next.customTarget || getPixelSize(next.specId, 300);
      next.cropWindow = next.source && clampCropWindow(next.cropWindow, next.source.width, next.source.height, target.width / target.height);
      if (!next.cropWindow) return { ok: false, error: error('SESSION_CROP', '裁剪范围无效，请重新选择') };
      next.cropConfirmed = false;
    }
    if (changed.includes('source')) {
      next.beauty = copy(DEFAULT_BEAUTY);
      next.suit = { enabled: false, templateId: 'black' };
    }
    stop('SESSION_STALE');
    state = { ...state, revision: state.revision + 1, sourceId: state.sourceId + (changed.includes('source') ? 1 : 0),
      params: next, changed, status: !next.source ? 'empty' : next.cropConfirmed ? 'ready' : 'crop',
      stage: next.cropConfirmed ? 'beauty' : 'crop', output: null, selfChecked: false, error: null };
    emit(); return { ok: true, state: snapshot() };
  }
  function confirmCrop() {
    if (active) return { ok: false, error: error('SESSION_BUSY', '正在处理，请等待或取消') };
    if (disposed || !state.params.source || !state.params.cropWindow) return { ok: false, error: error('SESSION_CROP', '请先选择照片和裁剪范围') };
    stop('SESSION_STALE');
    state = { ...state, revision: state.revision + 1, params: { ...state.params, cropConfirmed: true },
      changed: ['cropConfirmed'], status: 'ready', stage: 'beauty', output: null, selfChecked: false, error: null };
    emit(); return { ok: true, state: snapshot() };
  }
  function cancel() {
    stop('SESSION_CANCELLED');
    state = { ...state, revision: state.revision + 1, changed: ['cancel'], status: 'cancelled', output: null,
      selfChecked: false, error: error('SESSION_CANCELLED', '已取消，可以修改参数或重试') };
    emit();
  }
  async function execute(kind, work) {
    if (disposed) return { ok: false, error: error('SESSION_DISPOSED', '页面已离开') };
    if (active) return { ok: false, error: error('SESSION_BUSY', '正在处理，请等待或取消') };
    if (!state.params.source || (!state.params.cropConfirmed && kind !== 'crop-suggestion')) return { ok: false, error: error('SESSION_CROP_REQUIRED', '请先确认当前规格的裁剪范围') };
    const token = { id: ++serial, revision: state.revision, traceId: `T1-${Date.now()}-${sessionId}-${serial}`, cancellers: [], timer: null, reject: null };
    active = token;
    const current = () => active === token && state.revision === token.revision && !disposed;
    const check = () => { if (!current()) throw error('SESSION_STALE', '旧任务已失效', token.traceId); };
    const ctx = { sourceId: state.sourceId, revision: token.revision, params: freeze(copy(state.params)), traceId: token.traceId, current, check,
      async call(fn) { check(); const value = await fn(); check(); return value; },
      onCancel(fn) { check(); token.cancellers.push(fn); },
      step(stage) { check(); state = { ...state, stage }; emit(); } };
    const interrupted = new Promise((_, reject) => { token.reject = reject; });
    state = { ...state, status: 'processing', traceId: token.traceId, error: null, output: null, selfChecked: false, changed: [] }; emit();
    token.timer = setTimeout(() => {
      if (!current()) return;
      stop('SESSION_TIMEOUT');
      state = { ...state, status: 'error', output: null, selfChecked: false, error: error('SESSION_TIMEOUT', '处理超时，请重试', token.traceId) };
      log({ code: 'SESSION_TIMEOUT', traceId: token.traceId, kind }); emit();
    }, options.timeoutMs || 90000);
    try {
      const output = await Promise.race([Promise.resolve().then(() => { check(); return work(ctx); }), interrupted]);
      check(); state = { ...state, status: kind === 'crop-suggestion' ? 'crop' : 'success',
        stage: kind === 'crop-suggestion' ? 'crop' : 'export', output: kind === 'crop-suggestion' ? null : output, error: null }; emit();
      return { ok: true, output };
    } catch (cause) {
      if (!current()) return { ok: false, error: state.error || error('SESSION_STALE', '旧任务结果已丢弃', token.traceId) };
      const code = cause && String(cause.message || '').startsWith('AC5') ? 'SESSION_CONSENT' : 'SESSION_PROCESS_FAILED';
      const wrapped = error(code, code === 'SESSION_CONSENT' ? '端侧质量不足，请确认上云增强授权后重试' : '处理失败，请重试或更换照片', token.traceId);
      log({ code, traceId: token.traceId, kind, stage: state.stage });
      state = { ...state, status: 'error', output: null, selfChecked: false, error: wrapped }; emit();
      return { ok: false, error: wrapped };
    } finally { clearTimeout(token.timer); if (active === token) active = null; }
  }
  return { getState: snapshot, update, confirmCrop, cancel, execute,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    confirmSelfCheck(value) { if (state.status !== 'success') return false; state = { ...state, selfChecked: !!value }; emit(); return true; },
    dispose() { stop('SESSION_CANCELLED'); disposed = true; state = { ...state, revision: state.revision + 1, status: 'cancelled', output: null }; listeners.clear(); } };
}
module.exports = { createProcessingSession };
