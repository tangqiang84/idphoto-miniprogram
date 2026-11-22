'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const ts=require('../../idphoto-miniprogram/node_modules/typescript');
const asyncUtils=require('../../idphoto-miniprogram/src/core/asyncUtils');
const {segment}=require('../../idphoto-miniprogram/src/core/matting');
const {createConsentSession}=require('../../idphoto-miniprogram/src/core/consentSession');
function adapter(callFunction,authorization={check(){}}){
 const exports={};const file=path.resolve(__dirname,'../../idphoto-miniprogram/src/services/cloudFnAdapter.ts');
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new vm.Script(code).runInNewContext({exports,Date,require(n){if(n==='@tarojs/taro')return{__esModule:true,default:{cloud:{callFunction}}};if(n.endsWith('/asyncUtils'))return asyncUtils;throw Error('UNSUPPORTED_IMPORT');}});
 return exports.makeCloudFnAdapter({authorization});
}
function input(a){return{rgba:new Uint8ClampedArray(32*32*4),width:32,height:32,forceCloud:true,consents:['faceCloudEnhance'],cloud:{adapter:a}};}
test('实际15秒云适配器挂起后回落本地，迟到响应不改变已返回结果且无重试',async()=>{
 let release,calls=0;const a=adapter(()=>{calls++;return new Promise(r=>{release=r;});});const start=Date.now();
 const r=await segment(input(a));assert.ok(Date.now()-start>=asyncUtils.CLOUD_CALL_TIMEOUT_MS-50);assert.equal(calls,1);assert.ok(r.reasonCodes.includes('CLOUD_TIMEOUT'));assert.equal(r.evidence.kind,'traditional');
 const snapshot=Array.from(r.alpha);release({result:{provider:'baidu',alphaB64:'fixture'}});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(Array.from(r.alpha),snapshot);assert.equal(r.evidence.kind,'traditional');
});
test('实际云适配器每日额度17经过segment后保留本地alpha及CLOUD_QUOTA',async()=>{
 let calls=0;const r=await segment(input(adapter(async()=>{calls++;return{result:{error:'private_fixture',code:17}};})));
 assert.equal(calls,1);assert.equal(r.evidence.kind,'traditional');assert.ok(r.reasonCodes.includes('CLOUD_QUOTA'));assert.equal(r.alpha.length,1024);assert.equal(JSON.stringify(r.evidence).includes('private_fixture'),false);
});
test('真实超时包装不吞掉授权撤回，旧适配器不能再上传',async()=>{
 const consent=createConsentSession('T1');consent.update(['faceLocal','faceCloudEnhance']);let release,calls=0;
 const a=adapter(()=>{calls++;return new Promise(r=>{release=r;});},consent.capture('cloud'));
 const p=a.call({});consent.update(['faceLocal']);release({result:{provider:'baidu',alphaB64:'fixture'}});await assert.rejects(p,{code:'CONSENT_REVOKED'});await assert.rejects(a.call({}),{code:'CONSENT_REVOKED'});assert.equal(calls,1);
});
