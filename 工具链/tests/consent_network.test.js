'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const fs=require('fs'); const path=require('path'); const vm=require('vm');
const ts=require('../../idphoto-miniprogram/node_modules/typescript');
const { createConsentSession }=require('../../idphoto-miniprogram/src/core/consentSession');
function load(name, callFunction) {
  const file=path.resolve(__dirname,'../../idphoto-miniprogram/src/services/'+name+'.ts');
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};
  const context=vm.createContext({exports,Date,console:{warn(){}},require(request){
    if(name==='index') return request.endsWith('/mattingCloud') ? {makeHttpAdapter:()=>({call:callFunction})} : {};
    if(request==='@tarojs/taro')return {__esModule:true,default:{cloud:{callFunction}}};
    if(request.endsWith('/asyncUtils'))return {withTimeout:(promise)=>promise,CLOUD_CALL_TIMEOUT_MS:15000};
    if(request.endsWith('/poseContract'))return require('../../idphoto-miniprogram/src/core/poseContract');
    throw new Error('UNSUPPORTED_IMPORT');
  }});
  new vm.Script(code).runInContext(context,{timeout:2000});return exports;
}
test('RC-06真实云适配器：默认拒绝，只有cloud授权可调用；撤回前的迟到返回丢弃',async()=>{
  let calls=0; let release;
  const {makeCloudFnAdapter}=load('cloudFnAdapter',()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  await assert.rejects(makeCloudFnAdapter().call({}),{code:'CONSENT_REQUIRED'}); assert.equal(calls,0);
  const a=createConsentSession('T1');a.update(['faceLocal']);
  await assert.rejects(makeCloudFnAdapter({authorization:a.capture('cloud')}).call({}),{code:'CONSENT_REVOKED'});assert.equal(calls,0);
  a.update(['faceLocal','faceCloudEnhance']); const adapter=makeCloudFnAdapter({authorization:a.capture('cloud')});
  const pending=adapter.call({});a.update(['faceLocal']);a.update(['faceLocal','faceCloudEnhance']);release({result:{alphaB64:'fixture',region:'CN'}});
  await assert.rejects(pending,{code:'CONSENT_REVOKED'});await assert.rejects(adapter.call({}),{code:'CONSENT_REVOKED'});assert.equal(calls,1);
  const fresh=makeCloudFnAdapter({authorization:a.capture('cloud')});const ok=fresh.call({});release({result:{alphaB64:'fixture',region:'CN'}});assert.equal((await ok).alphaB64,'fixture');assert.equal(calls,2);
});
test('RC-06保留的HTTP云工厂同样默认拒绝无权限，撤回时丢弃返回',async()=>{
  let calls=0;let release;
  const {buildCloudAdapter}=load('index',()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  await assert.rejects(buildCloudAdapter().call({}),{code:'CONSENT_REQUIRED'});assert.equal(calls,0);
  const a=createConsentSession('T2');a.update(['faceLocal','faceCloudEnhance']);
  const pending=buildCloudAdapter({authorization:a.capture('cloud')}).call({});
  a.update(['faceLocal']);release('late');await assert.rejects(pending,{code:'CONSENT_REVOKED'});assert.equal(calls,1);
});
test('RC-06真实姿态服务：缺基础/上云/换装任一授权均零上传，撤回后不接受返回',async()=>{
  let calls=0;let release;
  const {requestPoseKeypoints}=load('poseService',()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const req={imageB64:'fixture',width:1,height:1,region:{x:0,y:0,w:1,h:1},canvasW:1,canvasH:1};
  const a=createConsentSession('T3');
  assert.equal((await requestPoseKeypoints(req)).reason,'posekey:consent_required');
  for(const list of [['faceLocal'],['faceLocal','suitSwap'],['faceLocal','faceCloudEnhance'],['faceCloudEnhance','suitSwap']]){
    a.update(list);assert.equal((await requestPoseKeypoints(req,a.capture('pose'))).reason,'posekey:consent_required');
  }
  assert.equal(calls,0);a.update(['faceLocal','faceCloudEnhance','suitSwap']);
  const pending=requestPoseKeypoints(req,a.capture('pose'));a.update(['faceLocal','suitSwap']);release({result:{}});
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.pose,null);assert.equal(calls,1);
});
test('RC-09真实云适配器保留额度错误码并隐藏原始服务错误',async()=>{const {makeCloudFnAdapter}=load('cloudFnAdapter',async()=>({result:{error:'private_fixture_payload',code:18}}));const adapter=makeCloudFnAdapter({authorization:{check(){}}});await assert.rejects(adapter.call({}),e=>e.code===18&&!e.message.includes('private_fixture_payload'));});
