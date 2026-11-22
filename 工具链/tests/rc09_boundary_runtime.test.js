'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {rebuild,inspectBoundary}=require('../rc09_boundary_runtime');
const decode=s=>Uint8Array.from(Buffer.from(s,'base64')).buffer;
test('增量重建保留源数据，拒绝越界、长度错误，响应撤回',async()=>{
 const base=new Uint8Array([1,2,3]);const spec={byteLength:3,segments:[{offset:1,length:2},{literal:'BA=='}]};
 assert.deepEqual(Array.from(await rebuild(base,spec,decode)),[2,3,4]);assert.deepEqual(Array.from(base),[1,2,3]);
 for(const bad of [{byteLength:1,segments:spec.segments},{byteLength:3,segments:[{offset:2,length:3}]},{byteLength:3,segments:[{offset:-1,length:3}]},{byteLength:4,segments:spec.segments}])await assert.rejects(rebuild(base,bad,decode),e=>e.code==='DELTA_INVALID');
 await assert.rejects(rebuild(base,spec,decode,()=>{throw {code:'CANCELLED'};}),e=>e.code==='CANCELLED');
});
test('边界全量检查NaN/Inf，抽样范围诚实标记',()=>{
 const spec={outputShape:[1,4],sampleIndices:[0,3],samples:[0,3],atol:1e-3,rtol:1e-3};
 const out=a=>({type:'float32',shape:[1,4],data:new Float32Array(a).buffer});
 assert.equal(inspectBoundary(out([0,1,2,3]),spec).status,'PASS');
 const bad=inspectBoundary(out([0,NaN,Infinity,3]),spec);assert.equal(bad.nanCount,1);assert.equal(bad.infCount,1);assert.equal(bad.status,'FAIL');
 assert.equal(inspectBoundary(out([0,1,2,9]),spec).code,'SAMPLED_MISMATCH');
 assert.equal(inspectBoundary(out([0,999,2,3]),spec).coverage,'all-finite+sampled-numeric');
 assert.equal(inspectBoundary({...out([0,1,2,3]),shape:[4]},spec).code,'TENSOR_CONTRACT_INVALID');
 const invalid=inspectBoundary(out([NaN,NaN,Infinity,-Infinity]),spec);
 assert.equal(invalid.maxSampleError,null);assert.equal(invalid.finiteSampleCount,0);
 assert.equal(invalid.nanCount,2);assert.equal(invalid.infCount,2);
});
test('用实际输入独立核对归一化，区分输入污染、原生NaN及有限超差',()=>{
 const {inspectNormalization}=require('../rc09_boundary_runtime');
 const spec={nodeIndex:245,shape:[1,1,2,2],epsilon:1e-5,scale:[2],bias:[.25],atol:1e-3,rtol:1e-3};
 const tensor=a=>({type:'float32',shape:spec.shape,data:new Float32Array(a).buffer});
 const constant=tensor([7,7,7,7]),bias=tensor([.25,.25,.25,.25]);
 const good=inspectNormalization(constant,bias,spec);assert.equal(good.status,'PASS');assert.equal(good.minChannelVariance,0);
 const bad=inspectNormalization(constant,tensor([NaN,NaN,NaN,NaN]),spec);assert.equal(bad.code,'NORMALIZATION_OUTPUT_NON_FINITE');assert.equal(bad.outputNonFiniteCount,4);assert.equal(bad.maxError,null);
 assert.equal(inspectNormalization(tensor([NaN,1,2,3]),bias,spec).code,'NORMALIZATION_INPUT_NON_FINITE');
 assert.equal(inspectNormalization(constant,tensor([1,1,1,1]),spec).code,'NORMALIZATION_MISMATCH');
 const norm=2/Math.sqrt(1.25+1e-5);const expected=[-1.5,-.5,.5,1.5].map(v=>v*norm+.25);
 assert.equal(inspectNormalization(tensor([0,1,2,3]),tensor(expected),spec).status,'PASS');
});
