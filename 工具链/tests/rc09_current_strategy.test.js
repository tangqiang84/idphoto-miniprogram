'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {probePage}=require('../page_flow_probe');
const {segment}=require('../../idphoto-miniprogram/src/core/matting');
const {encodeAlphaB64}=require('../../idphoto-miniprogram/src/core/mattingCloud');
for(const tool of ['T1','T2','T3'])for(const mode of ['baidu','offline','local-only'])test(`RC-09现行策略 ${tool}/${mode} 实际页面/本地算法/适配器接线`,async()=>{
 let calls=0,segments=0;const files=new Map();let result;
 const r=await probePage(tool,{...(mode==='local-only'?{consentIndices:[0]}:{}),
 prepareWorkCanvas:async()=>({w:64,h:80,rgba:new Uint8ClampedArray(64*80*4),plan:{sx:0,sy:0,sw:64,sh:80},crop:null,srcMetrics:null}),
 services:{segment:async p=>{segments++;result=await segment(p);return result;},applyBeauty(){},tightBBox:()=>null,
 buildCloudFnAdapter:({authorization})=>({kind:'cloudfn',endpoint:'cloud://CN',call:async req=>{authorization.check();calls++;if(mode==='offline')throw Error('network disconnected');return{provider:'baidu',region:'CN',alphaB64:encodeAlphaB64(Float32Array.from({length:req.width*req.height},(_,i)=>i%3===0?1:0))};}})},
 taro:{canvasToTempFilePath:async p=>{const name='fixture://'+files.size;files.set(name,{width:p.destWidth,height:p.destHeight,type:p.fileType});return{tempFilePath:name};},getImageInfo:async({src})=>files.get(src)},
 exercise:async h=>{assert.equal(segments,0);assert.equal(calls,0);h.flow.confirmCrop();assert.equal(segments,0);await h.flow.confirmBeauty(true);assert.equal(segments,1);assert.equal(result.qualityReviewed,false);
 if(mode==='local-only'){assert.equal(calls,0);assert.equal(result.evidence.cloudAttempted,false);assert.equal(result.evidence.kind,'traditional');}
 else{assert.equal(calls,1);assert.equal(result.evidence.cloudAttempted,true);if(mode==='offline'){assert.equal(result.evidence.kind,'traditional');assert.ok(result.reasonCodes.includes('CLOUD_UNAVAILABLE'));assert.equal(result.alpha.length,64*80);}else{assert.equal(result.evidence.provider,'baidu');assert.equal(result.backend,'cloud');}}
 assert.ok(h.flow.getState().preview);}});assert.equal(r.status,'PASS');
});
