'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWechatRuntime}=require('../../idphoto-miniprogram/src/services/wechatInference');
function fixture({load=true,output}={}) {
  const f={destroyed:0,calls:[],loaded:null,failed:null};
  f.platform={createInferenceSession(opts) {
    f.opts=opts;
    return {
      onLoad(fn) { f.loaded=fn; if(load)queueMicrotask(fn); },
      onError(fn) { f.failed=fn; }, offLoad() {}, offError() {},
      destroy() { f.destroyed++; },
      async run(feeds) {
        f.calls.push(feeds);
        return output || {output:{type:'float32',shape:[1,1,2,2],data:new Float32Array([0,.2,.8,1]).buffer}};
      }
    };
  }};
  return f;
}
test('RC-09微信原生桥接：加载完成才就绪；浮点Tensor子视图与输出可供真实后处理',async()=>{
 const f=fixture({load:false}),r=createWechatRuntime(f.platform,{inputSize:2});let ready=false;const p=r.InferenceSession.create('fixture.onnx').then(s=>{ready=true;return s;});await Promise.resolve();assert.equal(ready,false);assert.equal(f.calls.length,0);f.loaded();const s=await p;const storage=new Float32Array(15).fill(7),view=storage.subarray(2,14);const out=await s.run({input:new r.Tensor('float32',view,[1,3,2,2])});assert.equal(f.calls[0].input.data.byteLength,48);assert.deepEqual([...out.output.data],[0,Math.fround(.2),Math.fround(.8),1]);assert.equal(f.opts.precisionLevel,4);assert.equal(f.opts.allowQuantize,false);s.release();s.release();assert.equal(f.destroyed,1);await assert.rejects(s.run({}),{code:'MODEL_SESSION_RELEASED'});
});
test('RC-09微信原生错误/超时销毁；迟到加载不能恢复会话',async()=>{const f=fixture({load:false}),r=createWechatRuntime(f.platform,{inputSize:2,timeoutMs:5});const p=r.InferenceSession.create('fixture.onnx');await assert.rejects(p,{code:'MODEL_TIMEOUT'});f.loaded();assert.equal(f.destroyed,1);const g=fixture({load:false}),q=createWechatRuntime(g.platform).InferenceSession.create('fixture.onnx');g.failed({errMsg:'private-details'});await assert.rejects(q,{code:'MODEL_RUNTIME_INVALID',message:'端侧模型暂不可用'});assert.equal(g.destroyed,1);});
test('RC-09微信原生拒绝错误shape、NaN和无效输入，不把缓冲区误作TypedArray',async()=>{
 for(const output of [{output:{type:'float32',shape:[1,1,1,4],data:new Float32Array(4).buffer}},{output:{type:'float32',shape:[1,1,2,2],data:new Float32Array([NaN,0,0,0]).buffer}},{output:{type:'int8',shape:[1,1,2,2],data:new Float32Array(4).buffer}}]){const f=fixture({output}),r=createWechatRuntime(f.platform,{inputSize:2}),s=await r.InferenceSession.create('fixture.onnx');await assert.rejects(s.run({input:new r.Tensor('float32',new Float32Array(12),[1,3,2,2])}),{code:'MODEL_OUTPUT_INVALID'});await assert.rejects(s.run({input:new r.Tensor('float32',new Float32Array(2),[1,3,2,2])}),{code:'MODEL_TENSOR_INVALID'});s.release();}
 assert.equal(createWechatRuntime({}),null);
});
test('RC-09微信推理在途重复调用不启动第二次；超时销毁且迟到结果不复活',async()=>{
 const f=fixture();let complete;const create=f.platform.createInferenceSession;
 f.platform.createInferenceSession=opts=>({...create(opts),run:()=>new Promise(r=>{complete=r;})});
 const r=createWechatRuntime(f.platform,{inputSize:2,timeoutMs:5}),s=await r.InferenceSession.create('fixture.onnx');const feed={input:new r.Tensor('float32',new Float32Array(12),[1,3,2,2])};
 const pending=s.run(feed);await assert.rejects(s.run(feed),{code:'MODEL_SESSION_BUSY'});await assert.rejects(pending,{code:'MODEL_INFERENCE_TIMEOUT'});assert.equal(f.destroyed,1);complete({});await assert.rejects(s.run(feed),{code:'MODEL_SESSION_RELEASED'});
});
test('RC-09原生阶段观察可区分创建/加载/推理且观察异常不改变处理结果',async()=>{
 const f=fixture(),stages=[];const r=createWechatRuntime(f.platform,{inputSize:2,onStage:s=>stages.push(s)});const s=await r.InferenceSession.create('fixture.onnx');await s.run({input:new r.Tensor('float32',new Float32Array(12),[1,3,2,2])});assert.deepEqual(stages,['native-create-entered','native-create-returned','native-load-ready','native-run-entered','native-run-returned']);s.release();
 const g=fixture(),other=createWechatRuntime(g.platform,{inputSize:2,onStage(){throw Error('observer-only');}});const ready=await other.InferenceSession.create('fixture.onnx');assert.ok(ready);ready.release();
});
test('RC-09输出元数据定位错误shape/NaN，仍严格拒绝且不泄露张量数据',async()=>{
 for(const output of [{output:{type:'float32',shape:[1,1,1,4],data:new Float32Array(4).buffer}},{output:{type:'float32',shape:[1,1,2,2],data:new Float32Array([NaN,0,0,0]).buffer}}]){
  const records=[],f=fixture({output}),r=createWechatRuntime(f.platform,{inputSize:2,onOutputMetadata:m=>records.push(m)}),s=await r.InferenceSession.create('fixture.onnx');
  await assert.rejects(s.run({input:new r.Tensor('float32',new Float32Array(12),[1,3,2,2])}),{code:'MODEL_OUTPUT_INVALID'});
  assert.ok(records.length);assert.deepEqual(records[0].shape,output.output.shape);assert.equal(records[0].byteLength,16);assert.equal('data' in records[0],false);if(Number.isNaN(new Float32Array(output.output.data)[0]))assert.equal(records.at(-1).nonFiniteCount,1);s.release();
 }
});
test('RC-10六分类NHWC模型采用显式shape与输出名，原NCHW默认不变',async()=>{const f=fixture({output:{Identity:{type:'float32',shape:[1,2,2,6],data:new Float32Array(24).buffer}}}),r=createWechatRuntime(f.platform,{inputName:'input_29',outputName:'Identity',inputShape:[1,2,2,3],outputShape:[1,2,2,6]}),s=await r.InferenceSession.create('clothes.onnx');const out=await s.run({input_29:new r.Tensor('float32',new Float32Array(12),[1,2,2,3])});assert.deepEqual(f.opts.typicalShape.input_29,[1,2,2,3]);assert.equal(out.Identity.data.length,24);await assert.rejects(s.run({input_29:new r.Tensor('float32',new Float32Array(12),[1,3,2,2])}),{code:'MODEL_TENSOR_INVALID'});s.release();assert.equal(createWechatRuntime(f.platform,{inputShape:[1,NaN,2,3]}),null);});
