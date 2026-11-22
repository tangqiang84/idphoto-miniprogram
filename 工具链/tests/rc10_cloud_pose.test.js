'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {handlePose}=require('../../idphoto-miniprogram/cloudfunctions/matting/baiduPose');
const {handleMatting}=require('../../idphoto-miniprogram/cloudfunctions/matting');
const {handleSuitAsset,CHUNK_BYTES}=require('../../idphoto-miniprogram/cloudfunctions/matting/suitAssets');
const manifest=require('../../idphoto-miniprogram/cloudfunctions/matting/suit-assets/manifest.json');
const crypto=require('node:crypto');
const input=()=>({action:'pose',consent:'faceCloudEnhance',suitConsent:'suitSwap',region:'CN',retain:false,train:false,purpose:'pose_keypoints',width:100,height:140,image:'AAAA'});
const response=()=>({person_num:1,person_info:[{body_parts:{left_shoulder:{x:20,y:100,score:.9},right_shoulder:{x:80,y:100,score:.9}}}]});
function options(json=response()) {const calls=[];return {calls,env:{BAIDU_API_KEY:'fixture-ak',BAIDU_SECRET_KEY:'fixture-sk'},requestImpl:async(url,opts)=>{calls.push({url,opts});return {status:200,text:JSON.stringify(url.includes('/oauth/')?{access_token:'fixture-token',expires_in:3600}:json)};}};}
test('新姿态路由复用现有百度配置，只请求一次模型并归一双肩',async()=>{
 const o=options(),r=await handleMatting(input(),o);assert.equal(r.ok,true);assert.equal(r.personCount,1);assert.equal(r.keypoints[0].x,.2);assert.equal(r.model,'baidu-body-analysis');assert.equal(o.calls.length,2);assert.ok(o.calls[1].url.startsWith('https://aip.baidubce.com/rest/2.0/image-classify/v1/body_analysis?'));assert.equal(o.calls[1].opts.timeoutMs,5000);
});
test('无授权、错误用途、尺寸和超大输入均零外部请求',async()=>{
 for(const patch of [{consent:''},{suitConsent:''},{purpose:'other'},{retain:true},{region:'US'},{width:4097},{image:'a'.repeat(4*1024*1024+4)}]){
  const o=options(),r=await handlePose({...input(),...patch},o);assert.equal(r.ok,false);assert.ok(r.code&&r.message&&r.traceId);assert.equal(o.calls.length,0);
 }
});
test('多人、空人、列表不符、缺肩、低分、越界和边界截断明确拒绝',async()=>{
 const invalid=[{person_num:2,person_info:[{},{}]},{person_num:0,person_info:[]},{person_num:1,person_info:[]}];
 for(const patch of [null,{score:.49},{score:2},{x:-1},{x:0},{x:99},{y:140}]){const r=response();r.person_info[0].body_parts.left_shoulder=patch===null?null:{...r.person_info[0].body_parts.left_shoulder,...patch};invalid.push(r);}
 for(const json of invalid){const o=options(json),r=await handlePose(input(),o);assert.equal(r.ok,false);assert.ok(r.code&&r.message&&r.traceId);assert.equal(o.calls.length,2);}
});
test('提供方原始错误和异常不回传，不重试',async()=>{
 const o=options({error_code:6,error_msg:'PRIVATE_FIXTURE'});assert.ok(!JSON.stringify(await handlePose(input(),o)).includes('PRIVATE_FIXTURE'));assert.equal(o.calls.length,2);
 let calls=0;const r=await handlePose(input(),{...options(),requestImpl:async()=>{calls++;throw new Error('PRIVATE_FIXTURE')}});assert.equal(calls,1);assert.equal(r.code,'POSE_SERVICE_FAILED');assert.ok(!JSON.stringify(r).includes('PRIVATE_FIXTURE'));
});
test('模板分片原图摘要一致、边界校验及路径穿越拒绝',()=>{
 for(const item of manifest){const chunks=[];for(let chunk=0;chunk<Math.ceil(item.bytes/CHUNK_BYTES);chunk++){
   const r=handleSuitAsset({consent:'suitSwap',templateId:item.id,chunk});assert.equal(r.ok,true);assert.equal(r.chunk,chunk);assert.ok(r.dataB64.length<750000);chunks.push(Buffer.from(r.dataB64,'base64'));
  }const bytes=Buffer.concat(chunks);assert.equal(bytes.length,item.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.sha256);
 }
 for(const patch of [{consent:''},{templateId:'../../index.js'},{chunk:-1},{chunk:100},{chunk:.5}])assert.equal(handleSuitAsset({consent:'suitSwap',templateId:manifest[0].id,chunk:0,...patch}).ok,false);
});

test('衣物模型固定路由分片摘要一致，无授权和模板路径不可绕过',async()=>{
 const m=require('../../idphoto-miniprogram/cloudfunctions/matting/suit-parsing-model/manifest.json'),parts=[];
 for(let chunk=0;chunk<Math.ceil(m.bytes/CHUNK_BYTES);chunk++){const r=await handleMatting({action:'suit-parsing-model',consent:'suitSwap',templateId:m.id,chunk});assert.equal(r.ok,true);parts.push(Buffer.from(r.dataB64,'base64'));}
 const bytes=Buffer.concat(parts);assert.equal(bytes.length,m.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),m.sha256);
 for(const patch of [{consent:''},{templateId:'../../index.js'},{chunk:32},{action:'suit-template'}]){const r=await handleMatting({action:'suit-parsing-model',consent:'suitSwap',templateId:m.id,chunk:0,...patch});assert.equal(r.ok,false);assert.ok(r.code&&r.message&&r.traceId);}
});
