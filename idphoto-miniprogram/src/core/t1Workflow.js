'use strict';
// 只管理步骤与验收凭据；参数、异步版本和取消由processingSession持有。
const SCREENS = ['upload', 'crop', 'beauty', 'preview', 'dress', 'check', 'dpi', 'export'];
function hardFailures(output, final = true) {
  if (!output || !output.result || !Array.isArray(output.result.checks) || !output.result.checks.length) return ['缺少预审结果'];
  const missing = ['dimension', 'dpi', 'bg', 'filesize'].filter((key) => !output.result.checks.some((c) => c.key === key));
  if (missing.length) return ['预审缺少必需项目'];
  return output.result.checks.filter((c) => !c.pass && c.level !== 'advisory' && c.key !== 'head' && (final || c.key !== 'filesize')).map((c) => c.label);
}
function createT1Workflow(session, adapters, options = {}) {
  const tool = options.tool || 'T1';
  if (!['T1', 'T2', 'T3', 'T5'].includes(tool)) throw new Error('不支持的流程工具');
  const screens = tool === 'T5' ? ['upload', 'crop', 'dpi', 'export'] : SCREENS.filter((s) => tool !== 'T2' || s !== 'dress');
  let screen = 'upload'; let approvedBeauty = ''; let reviewed = ''; let mirror = '';
  let preview = null; let finalResult = null; let pendingSelf = false; let failure = null;
  let revision = session.getState().revision; let disposed = false;
  const listeners = new Set();
  const key = (omit = []) => { const s = session.getState(); return JSON.stringify([s.sourceId, ...Object.entries(s.params).filter(([k]) => !omit.includes(k))]); };
  const beautyKey = () => key(['bg', 'suit', 'dpi', 'consents', 'kbLimit']);
  const baseKey = () => key(tool === 'T5' ? ['dpi', 'kbLimit'] : ['dpi']);
  const current = (item) => {
    const s = session.getState();
    return !!item && s.status === 'success' && item.traceId === s.traceId && item.revision === s.revision && s.output?.preview === item.preview;
  };
  const getState = () => ({ screen, preview, finalResult, pendingSelf, mirrorConfirmed: !!mirror && mirror === beautyKey(),
    error: failure || session.getState().error, session: session.getState() });
  const emit = () => { if (!disposed) for (const fn of listeners) fn(getState()); };
  const fail = (code, message) => { failure = { code, message, traceId: session.getState().traceId }; emit(); return { ok: false, error: failure }; };
  const requireStep = (...allowed) => !disposed && allowed.includes(screen) && session.getState().status !== 'processing';
  const unsubscribe = session.subscribe((s) => {
    if (s.revision !== revision) {
      revision = s.revision; finalResult = null; pendingSelf = false; failure = null;
      const changed = s.changed;
      if (changed.includes('source')) { screen = s.params.source ? 'crop' : 'upload'; approvedBeauty = ''; reviewed = ''; mirror = ''; preview = null; }
      else if (changed.some((x) => ['specId', 'customTarget', 'cropWindow', 'cropConfirmed'].includes(x))) { screen = s.params.source ? 'crop' : 'upload'; approvedBeauty = ''; reviewed = ''; mirror = ''; preview = null; }
      else if (changed.includes('beauty')) { screen = 'beauty'; approvedBeauty = ''; reviewed = ''; mirror = ''; preview = null; }
      else if (changed.includes('consents')) { if (!s.params.consents.includes('faceLocal')) screen = 'upload'; else if (['export', 'check', 'dpi', 'preview'].includes(screen)) screen = s.params.cropConfirmed ? 'beauty' : 'crop'; reviewed = ''; preview = null; }
      else if (changed.includes('kbLimit')) { screen = 'dpi'; }
      else if (changed.includes('dpi')) { screen = 'dpi'; }
      else if (changed.includes('cancel')) { /* 参数未变，保留已完成的预审凭据供重试。 */ }
      else { reviewed = ''; preview = null; }
    }
    emit();
  });
  function stamp(output) { const s = session.getState(); return { ...output, traceId: s.traceId, revision: s.revision, key: baseKey() }; }
  async function process(mode, destination, strokes) {
    if (approvedBeauty !== beautyKey() || !session.getState().params.cropConfirmed) return fail('FLOW_BEAUTY_REQUIRED', '请先确认裁剪和美颜');
    failure = null; finalResult = null; pendingSelf = false;
    const result = await session.execute(mode === 'final' ? 't1-final' : 't1-preview', (task) => adapters.process(task, mode, strokes));
    if (disposed) return { ok: false };
    if (!result.ok) { if (session.getState().status === 'error') failure = result.error; emit(); return result; }
    failure = null;
    if (!result.output || typeof result.output.preview !== 'string' || result.output.isFinal !== (mode === 'final')) return fail('FLOW_OUTPUT', '处理结果缺少预览/成品标识，请重试');
    if (mode === 'final') {
      finalResult = stamp(result.output);
      if (tool === 'T3' && !finalResult.suitApplied) { finalResult = null; screen = 'dress'; return fail('FLOW_SUIT_REQUIRED', '换装未成功，请重新应用并自检'); }
      if (hardFailures(finalResult).length) { const failed = hardFailures(finalResult); finalResult = null; screen = 'dpi'; return fail('FLOW_HARD_CHECK', '成品有必需指标不通过：' + failed.join('、')); }
      if (finalResult.suitApplied) { pendingSelf = true; screen = 'dpi'; }
      else screen = 'export';
    } else {
      preview = stamp(result.output); reviewed = ''; screen = destination;
      if (destination === 'dress' && preview.suitApplied) pendingSelf = true;
    }
    emit(); return result;
  }
  return { getState,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    resumeCrop() { if (screen !== 'upload' || !session.getState().params.source || (tool !== 'T5' && !session.getState().params.consents.includes('faceLocal'))) return fail('FLOW_STEP', '请先同意本地处理并选择照片'); screen = 'crop'; emit(); return { ok: true }; },
    selectImage(source) { failure = null; return session.update({ source }); },
    update(change) { failure = null; return session.update(tool !== 'T5' && change.consents && !change.consents.includes('faceLocal') ? { ...change, source: null } : change); },
    async suggest() {
      if (!requireStep('crop')) return fail('FLOW_STEP', '请先选择照片');
      const result = await session.execute('crop-suggestion', (task) => adapters.suggest(task));
      if (result.ok && result.output) session.update({ cropWindow: result.output });
      emit(); return result;
    },
    confirmCrop() {
      if (!requireStep('crop')) return fail('FLOW_STEP', '请在裁剪步骤确认');
      const result = session.confirmCrop(); if (result.ok) { screen = tool === 'T5' ? 'dpi' : 'beauty'; if (tool === 'T5') { approvedBeauty = beautyKey(); reviewed = baseKey(); } failure = null; emit(); } return result;
    },
    async confirmBeauty(skip = false) {
      if (!requireStep('beauty')) return fail('FLOW_STEP', '请先完成裁剪，再确认美颜');
      if (skip) session.update({ beauty: { ...session.getState().params.beauty, enabled: false } });
      approvedBeauty = beautyKey(); return process('preview', 'preview');
    },
    async background(bg) {
      if (!requireStep('preview')) return fail('FLOW_STEP', '请在换底预览步骤修改底色');
      const updated = session.update({ bg });
      if (!updated.ok) return fail(updated.error.code, updated.error.message);
      return process('preview', 'preview');
    },
    async patch(strokes, expectedTrace) {
      if (!requireStep('preview') || !current(preview) || expectedTrace !== preview.traceId) return fail('FLOW_STALE', '预览已变化，请重新打开修补');
      return process('preview', 'preview', strokes);
    },
    nextDress() {
      if (!requireStep('preview') || (!current(preview) && !(reviewed === baseKey() && preview?.key === baseKey()))) return fail('FLOW_PREVIEW_REQUIRED', '请先生成当前参数的预览');
      screen = tool === 'T2' ? 'check' : 'dress'; failure = null; emit(); return { ok: true };
    },
    async applySuit() {
      if (!['T1', 'T3'].includes(tool)) return fail('FLOW_STEP', '此工具不支持换装');
      if (!requireStep('dress')) return fail('FLOW_STEP', '请在换装步骤操作');
      if (!session.getState().params.consents.includes('suitSwap')) return fail('FLOW_CONSENT', '请先单独同意换装授权');
      session.update({ suit: { ...session.getState().params.suit, enabled: true } });
      const result = await process('preview', 'dress');
      if (result.ok && !preview.suitApplied) return fail('FLOW_SUIT_REJECTED', preview.suitReason || '未能完成换装，可以更换模板或跳过');
      return result;
    },
    async skipSuit() {
      if (tool !== 'T1') return fail('FLOW_SUIT_REQUIRED', '此流程不能跳过换装');
      if (!requireStep('dress')) return fail('FLOW_STEP', '请在换装步骤选择');
      if (session.getState().params.suit.enabled || (!current(preview) && !(reviewed === baseKey() && preview?.key === baseKey()))) {
        session.update({ suit: { ...session.getState().params.suit, enabled: false } });
        return process('preview', 'check');
      }
      screen = 'check'; failure = null; emit(); return { ok: true };
    },
    confirmSelfCheck(value) { session.confirmSelfCheck(value); emit(); },
    acceptSelfCheck() {
      const s = session.getState(); const item = pendingSelf && screen === 'dpi' ? finalResult : preview;
      if (!pendingSelf || !current(item) || !s.selfChecked) return fail('FLOW_SELF_CHECK', '请核对当前成品五官并勾选确认');
      pendingSelf = false; failure = null; screen = item === finalResult ? 'export' : 'check'; emit(); return { ok: true };
    },
    goDpi() {
      const accepted = reviewed === baseKey() && preview?.key === baseKey();
      if (tool === 'T3' && (!preview?.suitApplied || !accepted && !session.getState().selfChecked)) return fail('FLOW_SUIT_REQUIRED', '请先完成换装和当前结果自检');
      if (!requireStep('check') || (!current(preview) && !accepted)) return fail('FLOW_PRECHECK_REQUIRED', '请先完成当前预览的预审');
      if (!accepted && preview.suitApplied && !session.getState().selfChecked) return fail('FLOW_SELF_CHECK', '请先完成换装自检');
      const failures = hardFailures(preview, false);
      if (failures.length) return fail('FLOW_HARD_CHECK', '请先修正：' + failures.join('、'));
      reviewed = baseKey(); screen = 'dpi'; failure = null; emit(); return { ok: true };
    },
    setDpi(dpi) {
      if (!requireStep('dpi')) return fail('FLOW_STEP', '请在输出档位步骤选择');
      failure = null; const result = session.update({ dpi }); emit(); return result;
    },
    confirmMirror(value) { mirror = value ? beautyKey() : ''; failure = null; emit(); },
    async export() {
      if (pendingSelf) return fail('FLOW_SELF_CHECK', '请先核对当前最终成品并确认自检');
      if (!requireStep('dpi') || reviewed !== baseKey()) return fail('FLOW_PRECHECK_REQUIRED', '参数已变化，请重新预审');
      if (!mirror || mirror !== beautyKey()) return fail('FLOW_MIRROR', '请先完成人工镜像自查');
      return process('final', 'export');
    },
    exportResult(expectedTrace) {
      if (!requireStep('export') || !current(finalResult) || !finalResult.isFinal || reviewed !== baseKey()
          || expectedTrace !== finalResult.traceId) return fail('FLOW_FINAL_REQUIRED', '请先确认档位并生成当前最终成品');
      if (!mirror || mirror !== beautyKey()) return fail('FLOW_MIRROR', '请完成人工镜像自查');
      if (finalResult.suitApplied && !session.getState().selfChecked) return fail('FLOW_SELF_CHECK', '请重新完成当前换装成品自检');
      if (tool === 'T3' && !finalResult.suitApplied) return fail('FLOW_SUIT_REQUIRED', '请先完成换装');
      if (hardFailures(finalResult).length) return fail('FLOW_HARD_CHECK', '成品必需指标未通过');
      return { ok: true, output: finalResult };
    },
    back() {
      if (session.getState().status === 'processing') session.cancel();
      const index = screens.indexOf(screen); screen = screens[Math.max(0, index - 1)]; pendingSelf = false; failure = null; emit();
    },
    cancel() { session.cancel(); emit(); },
    retry() { if (screen === 'beauty' || screen === 'preview') return process('preview', 'preview'); if (screen === 'dress') return process('preview', 'dress'); if (screen === 'dpi') return this.export(); return this.suggest(); },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); } };
}
module.exports = { createT1Workflow, hardFailures };
