'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessingSession } = require('../processingSession');
const { createT1Workflow } = require('../t1Workflow');
function setup(tool) {
  const session = createProcessingSession({ logger() {} }); const calls = [];
  const flow = createT1Workflow(session, { process: async (task, mode) => {
    calls.push(mode);
    return { preview: 'fixture://' + calls.length, isFinal: mode === 'final', suitApplied: false,
      result: { checks: ['dimension', 'dpi', 'bg', 'filesize'].map(key => ({ key, pass: true })) } };
  } }, { tool });
  flow.update({ consents: ['faceLocal'] }); flow.selectImage({ path: 'fixture://source', width: 1200, height: 1600 });
  return { flow, calls, dispose() { flow.dispose(); session.dispose(); } };
}
test('RC-07 T2预览后直接预审，返回不经过换装', async () => {
  const s = setup('T2'); s.flow.confirmCrop(); await s.flow.confirmBeauty(true);
  assert.equal(s.flow.nextDress().ok, true); assert.equal(s.flow.getState().screen, 'check');
  s.flow.back(); assert.equal(s.flow.getState().screen, 'preview');
  assert.equal((await s.flow.applySuit()).ok, false); s.dispose();
});
test('RC-07 T3不能用跳过换装进入预审', async () => {
  const s = setup('T3'); s.flow.confirmCrop(); await s.flow.confirmBeauty(true); s.flow.nextDress();
  assert.equal((await s.flow.skipSuit()).ok, false); assert.equal(s.flow.getState().screen, 'dress');
  assert.equal(s.flow.goDpi().ok, false); s.dispose();
});
test('RC-07 T5裁剪直接进入档位，不调用预览或美颜动作', async () => {
  const s = setup('T5'); s.flow.confirmCrop(); assert.equal(s.flow.getState().screen, 'dpi');
  assert.deepEqual(s.calls, []); assert.equal((await s.flow.confirmBeauty()).ok, false);
  s.flow.confirmMirror(true); await s.flow.export(); assert.deepEqual(s.calls, ['final']);
  s.flow.back(); s.flow.back(); assert.equal(s.flow.getState().screen, 'crop'); s.dispose();
});
test('RC-07 T2自定义色/透明参数合法，T1不因此放宽；T5自定义范围不静默截断',()=>{
 const t2=createProcessingSession({tool:'T2'});const t1=createProcessingSession();const t5=createProcessingSession({tool:'T5'});
 assert.equal(t2.update({bg:null}).ok,true);assert.equal(t2.update({bg:'67,142,219'}).ok,true);assert.equal(t2.update({bg:'300,0,0'}).ok,false);
 assert.equal(t1.update({bg:null}).ok,false);assert.equal(t5.update({customTarget:{width:5001,height:10}}).ok,false);
 assert.equal(t5.update({customTarget:{width:320,height:480}}).ok,true);t1.dispose();t2.dispose();t5.dispose();
});
test('RC-07渐变负方向从终点反向，不退化成整幅起点色',()=>{
 const {resolveBackground,sampleGradient}=require('../color');
 const g=resolveBackground({type:'gradient',from:'#000000',to:'#FFFFFF',angle:180});
 assert.ok(sampleGradient(g,0,0,100,100)[0]>sampleGradient(g,99,0,100,100)[0]);
 const v=resolveBackground({type:'gradient',from:'#000000',to:'#FFFFFF',angle:270});
 assert.ok(sampleGradient(v,0,0,100,100)[0]>sampleGradient(v,0,99,100,100)[0]);
});
