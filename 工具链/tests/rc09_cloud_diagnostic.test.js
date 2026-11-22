'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('../../idphoto-miniprogram/node_modules/typescript');
function load(call){const exports={};const code=ts.transpileModule(fs.readFileSync('idphoto-miniprogram/src/services/cloudFnAdapter.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new vm.Script(code).runInNewContext({exports,Date,console:{warn(){},info(){}},require(n){if(n==='@tarojs/taro')return{__esModule:true,default:{cloud:{callFunction:call}}};return{withTimeout:p=>p,CLOUD_CALL_TIMEOUT_MS:15000};}});return exports.makeCloudFnAdapter;}
test('SDK拒绝只记录数值码/阶段/trace，不泄露原始敏感错误',async()=>{const records=[];const make=load(async()=>{throw{errCode:-501000,errMsg:'fixture private_token https://private.invalid/photo'};});await assert.rejects(make({authorization:{check(){}},onDiagnostic:r=>records.push(r)}).call({image:'private_photo'}),e=>e.code===-501000&&!JSON.stringify(e).includes('private'));assert.equal(records.length,1);assert.equal(records[0].phase,'SDK_REJECTED');assert.equal(records[0].sdkCode,-501000);assert.ok(records[0].traceId);assert.equal(JSON.stringify(records).includes('private'),false);});
test('诊断观察失败不影响成功响应和额度错误码',async()=>{const make=load(async()=>({result:{provider:'baidu',alphaB64:'fixture'}}));assert.equal((await make({authorization:{check(){}},onDiagnostic(){throw Error('observer');}}).call({})).provider,'baidu');const r=[];await assert.rejects(load(async()=>({result:{error:'private_fixture',code:17}}))({authorization:{check(){}},onDiagnostic:x=>r.push(x)}).call({}),e=>e.code===17);assert.equal(r[0].phase,'FUNCTION_ERROR');assert.equal(JSON.stringify(r).includes('private'),false);});
test('RC-11 云响应可按任务 TraceID 关联，非契约字符串不会进诊断',async()=>{
 const records=[];
 const taskTraceId='T3-1795392000000-2-4';
 const cloudTraceId='suitfit-0123456789abcdef0123456789abcdef';
 for(const responseTrace of [cloudTraceId,'private_token_0123456789']){
  const make=load(async()=>({result:{ok:false,code:'SUIT_NECK_UNAVAILABLE',traceId:responseTrace}}));
  await make({resultType:'raw',authorization:{traceId:taskTraceId,check(){}},onDiagnostic:r=>records.push(r)}).call({});
 }
 assert.equal(records[0].taskTraceId,taskTraceId);
 assert.equal(records[0].cloudTraceId,cloudTraceId);
 assert.equal(records[0].phase,'FUNCTION_ERROR');
 assert.notEqual(records[0].traceId,taskTraceId);
 assert.equal(records[1].cloudTraceId,null);
 assert.doesNotMatch(JSON.stringify(records),/private_token/);
});
