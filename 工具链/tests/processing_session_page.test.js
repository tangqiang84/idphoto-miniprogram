'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probePage } = require('../page_flow_probe');
function prepared() { return { w: 64, h: 80, rgba: new Uint8ClampedArray(64 * 80 * 4), canvas: {},
  plan: { sx: 0, sy: 0, sw: 64, sh: 80 }, crop: null, srcMetrics: null }; }
function fixture() {
  const f = { preparations: [], segments: [], beauties: [], renders: [], saved: [], prints: [], files: new Map(), session: null };
  f.options = {
    prepareWorkCanvas: async (input) => { f.preparations.push(input); return prepared(); },
    services: {
      segment: async (input) => { f.segments.push(input); return { alpha: new Float32Array(5120).fill(1), backend: 'fixture' }; },
      applyBeauty: (...input) => f.beauties.push(input), tightBBox: () => null, alphaBBox: () => null,
    },
    taro: {
      canvasToTempFilePath: async (input) => {
        const path = `fixture://result-${f.renders.length}`;
        f.renders.push({ ...input, phase: f.session?.getState().stage });
        f.files.set(path, { width: input.destWidth, height: input.destHeight });
        return { tempFilePath: path };
      },
      getImageInfo: async ({ src }) => f.files.get(src),
      getFileSystemManager: () => ({ getFileInfo: ({ success }) => success({ size: 60 * 1024 }) }),
      saveImageToPhotosAlbum: async ({ filePath }) => { f.saved.push(filePath); },
      navigateTo: async ({ url }) => { f.prints.push(url); },
    },
  };
  return f;
}
const find = (h, type) => h.nodes(h.render(), (n) => n.type === type)[0];
const button = (h, cls) => h.nodes(h.render(), (n) => n.type === 'Button' && n.props.className === cls)[0];
const screen = (h, expected) => {
  const rows = h.nodes(h.render(), (n) => String(n.props.className || '').split(' ').includes('flow-screen'));
  assert.equal(rows.length, 1); assert.ok(rows[0].props.className.includes('screen-' + expected));
};
async function preview(h) { find(h, 'CropStep').props.onApplyCrop(); await find(h, 'BeautyStep').props.onApply(); }
async function dpi(h) { await preview(h); button(h, 'flow-next-dress').props.onClick(); await button(h, 'flow-skip-suit').props.onClick(); button(h, 'flow-next-dpi').props.onClick(); }
async function finalize(h) { find(h, 'MirrorCheck').props.onChange(true); await button(h, 'flow-confirm-dpi').props.onClick(); }
async function run(f, exercise) { return probePage('T1', { ...f.options, exercise: async (h) => { f.session = h.session; return exercise(h); } }); }
function suitFixture(f) { Object.assign(f.options.services, { tightBBox: () => ({}), measureHeadMetrics: async () => ({ ok: false }),
  checkComposition: () => ({ ok: true }), fitSuitV2: () => ({ ok: true, place: {}, audit: { source: 'mock' } }), suitCompose: (rgba) => rgba }); }
async function suit(h) {
  await preview(h); button(h, 'flow-next-dress').props.onClick();
  h.nodes(h.render(), (n) => n.props.className === 'suit-consent')[0].props.onClick();
  await button(h, 'flow-apply-suit').props.onClick();
}
function checkSelf(h) { h.nodes(h.render(), (n) => n.props.className === 'selfcheck')[0].props.onClick(); button(h, 'flow-accept-selfcheck').props.onClick(); }

test('T1真实页面回调：各步骤独立，裁剪和美颜确认前零下游，确认档位后才有最终文件', async () => {
  const f = fixture(); await run(f, async (h) => {
    screen(h, 'crop'); assert.equal(f.segments.length, 0);
    find(h, 'CropStep').props.onApplyCrop(); screen(h, 'beauty'); assert.equal(f.segments.length, 0);
    assert.equal(find(h, 'DpiStep'), undefined);
    await find(h, 'BeautyStep').props.onApply(); screen(h, 'preview');
    assert.equal(f.renders.length, 1); assert.equal(f.renders[0].phase, 'preview');
    assert.equal(button(h, 'flow-save'), undefined);
    button(h, 'flow-next-dress').props.onClick(); screen(h, 'dress');
    await button(h, 'flow-skip-suit').props.onClick(); screen(h, 'check');
    button(h, 'flow-next-dpi').props.onClick(); screen(h, 'dpi');
    find(h, 'DpiStep').props.onChange(600); assert.equal(f.renders.length, 1);
    await finalize(h); screen(h, 'export');
    assert.deepEqual(f.renders.map((r) => r.phase), ['preview', 'export']);
    assert.equal(h.flow.getState().finalResult.width, 591);
    await button(h, 'flow-save').props.onClick(); await button(h, 'flow-print').props.onClick();
    assert.equal(f.saved.length, 1); assert.equal(f.prints.length, 1);
  });
});
test('T1跳过美颜不调用美颜；返回保留裁剪和参数，改规格重新确认', async () => {
  const f = fixture(); await run(f, async (h) => {
    find(h, 'CropStep').props.onCropWindowChange({ x: 30, y: 50, w: 400, h: 560 });
    const crop = h.session.getState().params.cropWindow;
    find(h, 'CropStep').props.onApplyCrop();
    find(h, 'BeautyStep').props.onChange({ enabled: true, smooth: 0.2, whiten: 0.1, brighten: 0.1 });
    await button(h, 'flow-skip-beauty').props.onClick(); assert.equal(f.beauties.length, 0);
    assert.deepEqual(f.preparations.at(-1).cropWindow, crop);
    button(h, 'flow-back').props.onClick(); screen(h, 'beauty');
    assert.deepEqual(h.session.getState().params.cropWindow, crop);
    button(h, 'flow-back').props.onClick(); button(h, 'flow-back').props.onClick(); screen(h, 'upload');
    find(h, 'Picker').props.onChange({ detail: { value: 8 } }); screen(h, 'crop');
    assert.equal(h.session.getState().params.cropConfirmed, false);
    assert.equal(h.session.getState().params.cropWindow.w, h.session.getState().params.cropWindow.h);
  });
});
test('T1换装两次新结果都要求自检；当前自检撤销后不能保存或冲印', async () => {
  const f = fixture(); suitFixture(f); await run(f, async (h) => {
    await suit(h); assert.equal(h.flow.getState().pendingSelf, true);
    assert.equal(h.flow.acceptSelfCheck().ok, false); checkSelf(h); screen(h, 'check');
    button(h, 'flow-next-dpi').props.onClick(); await finalize(h);
    assert.equal(h.flow.getState().pendingSelf, true); assert.equal(button(h, 'flow-save'), undefined);
    checkSelf(h); screen(h, 'export');
    const save = button(h, 'flow-save').props.onClick; const print = button(h, 'flow-print').props.onClick;
    h.flow.confirmSelfCheck(false); await save(); await print(); assert.equal(f.saved.length, 0); assert.equal(f.prints.length, 0);
    h.flow.confirmSelfCheck(true); await button(h, 'flow-save').props.onClick(); assert.equal(f.saved.length, 1);
  });
});
test('T1旧保存/冲印/修补回调不能消费新任务结果，当前修补仍有效', async () => {
  const f = fixture(); await run(f, async (h) => {
    await preview(h); button(h, 'flow-patch').props.onClick(); const oldPatch = find(h, 'AlphaPatch').props.onApply;
    await h.flow.background('blue'); const current = h.session.getState().output.preview;
    await oldPatch([]); assert.equal(h.session.getState().output.preview, current);
    button(h, 'flow-patch').props.onClick(); await find(h, 'AlphaPatch').props.onApply([]);
    button(h, 'flow-next-dress').props.onClick(); await button(h, 'flow-skip-suit').props.onClick(); button(h, 'flow-next-dpi').props.onClick();
    await finalize(h); const oldSave = button(h, 'flow-save').props.onClick; const oldPrint = button(h, 'flow-print').props.onClick;
    button(h, 'flow-back').props.onClick(); await finalize(h);
    await oldSave(); await oldPrint(); assert.equal(f.saved.length, 0); assert.equal(f.prints.length, 0);
    await button(h, 'flow-save').props.onClick(); assert.equal(f.saved.length, 1);
  });
});
test('T1旧prepare迟到、重复确认和取消不能再触发抠图；失败可重试', async () => {
  const f = fixture(); let release; let hang = true;
  f.options.prepareWorkCanvas = async (input) => input.cropWindow && hang ? new Promise((resolve) => { release = resolve; }) : prepared();
  await run(f, async (h) => {
    find(h, 'CropStep').props.onApplyCrop(); const pending = find(h, 'BeautyStep').props.onApply();
    await Promise.resolve(); await Promise.resolve();
    await h.flow.confirmBeauty(); assert.equal(f.segments.length, 0);
    button(h, 'flow-cancel').props.onClick(); await pending;
    hang = false; release(prepared()); await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.segments.length, 0);
    await h.flow.retry(); screen(h, 'preview'); assert.equal(f.segments.length, 1);
  });
});
test('T1导出硬指标失败或文件信息缺失，不能提供最终成品入口', async () => {
  const f = fixture(); const info = f.options.taro.getImageInfo;
  f.options.taro.getImageInfo = async (input) => f.session.getState().stage === 'export' ? { width: 13, height: 19 } : info(input);
  await run(f, async (h) => { await dpi(h); await finalize(h); screen(h, 'dpi'); assert.equal(button(h, 'flow-save'), undefined); assert.equal(h.flow.getState().error.code, 'FLOW_HARD_CHECK'); });
});
test('T1镜像与预审不可绕过，旧步骤确认回调不得触发处理', async () => {
  const f = fixture(); await run(f, async (h) => {
    const oldCrop = find(h, 'CropStep').props.onApplyCrop;
    await dpi(h); await button(h, 'flow-confirm-dpi').props.onClick();
    assert.equal(f.renders.filter((r) => r.phase === 'export').length, 0);
    assert.equal(h.flow.getState().error.code, 'FLOW_MIRROR');
    const before = f.segments.length; oldCrop(); assert.equal(f.segments.length, before);
    await finalize(h); screen(h, 'export'); h.flow.confirmMirror(false);
    await button(h, 'flow-save').props.onClick(); assert.equal(f.saved.length, 0);
  });
});
test('T1本地智能建议保留原图坐标，且不冒充美颜/最终成品', async () => {
  const f = fixture(); f.options.prepareWorkCanvas = async (input) => { f.preparations.push(input); return { ...prepared(), crop: input.cropWindow ? null : { sx: 60, sy: 100, sw: 400, sh: 560 } }; };
  await run(f, async (h) => {
    const crop = h.session.getState().params.cropWindow; assert.equal(crop.x, 60); assert.equal(f.renders.length, 0);
    find(h, 'CropStep').props.onApplyCrop(); assert.equal(f.segments.length, 0);
    await find(h, 'BeautyStep').props.onApply(); assert.deepEqual(f.preparations.at(-1).cropWindow, crop);
  });
});
test('RC-06 T1成品后撤回上云/本地授权使旧输出和旧保存回调失效', async () => {
  const f=fixture();await run(f,async(h)=>{
    await dpi(h);await finalize(h);const oldSave=button(h,'flow-save').props.onClick;
    h.flow.update({consents:['faceLocal']});screen(h,'beauty');await oldSave();assert.equal(f.saved.length,0);
    await find(h,'BeautyStep').props.onApply();button(h,'flow-next-dress').props.onClick();await button(h,'flow-skip-suit').props.onClick();button(h,'flow-next-dpi').props.onClick();await finalize(h);
    await oldSave();assert.equal(f.saved.length,0);const freshSave=button(h,'flow-save').props.onClick;await freshSave();assert.equal(f.saved.length,1);
    h.flow.update({consents:[]});screen(h,'upload');assert.equal(h.session.getState().params.source,null);
    await freshSave();assert.equal(f.saved.length,1);
  });
});
