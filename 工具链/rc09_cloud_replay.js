'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const core=require('../idphoto-miniprogram/src/core/mattingCloud');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(value,code){if(!value)throw{safeCode:code};}
function f32(bytes){return new Float32Array(Uint8Array.from(bytes).buffer);}
function stats(a){let min=Infinity,max=-Infinity,nonFinite=0;for(const v of a){if(!Number.isFinite(v))nonFinite++;else{min=Math.min(min,v);max=Math.max(max,v);}}return{length:a.length,min,max,nonFinite};}
async function main(args){
 const outPos=args.indexOf('--out');check(outPos>=0&&args[outPos+1],'ARGUMENT_INVALID');const out=path.resolve(args[outPos+1]);check(!fs.existsSync(out),'OUTPUT_EXISTS');fs.mkdirSync(out,{recursive:true});
 const root=path.resolve(__dirname,'..'),base=path.join(root,'docs/验证记录/RC-09-cloud-photo-plan-20261105');const planBytes=fs.readFileSync(path.join(base,'prepared/plan.json')),plan=JSON.parse(planBytes),live=JSON.parse(fs.readFileSync(path.join(base,'live-run-01/report.json')));check(hash(planBytes)===live.planSha256&&live.calls===3&&live.status==='PASS','LIVE_EVIDENCE_INVALID');const records=[];
 for(const s of plan.samples){
  const folder=path.join(out,s.id);fs.mkdirSync(folder);const [w,h]=s.dimensions;
  const rgba=new Uint8ClampedArray(fs.readFileSync(path.join(base,'prepared',s.id,'source.rgba')));check(rgba.length===w*h*4,'SOURCE_SIZE_INVALID');
  const local=f32(fs.readFileSync(path.join(root,'docs/验证记录/RC-09-photo-device-20261105/device-run-02/rendered',s.id,'restored-alpha.float32')));check(local.length===w*h,'LOCAL_SIZE_INVALID');
  const cloud=fs.readFileSync(path.join(base,'live-run-01',s.id+'-alpha.uint8')),rec=live.records.find(x=>x.id===s.id);check(hash(cloud)===rec.alphaSha256&&cloud.length===s.crop.w*s.crop.h,'CLOUD_ALPHA_CHANGED');
  const region=core.pickUploadRegion(rgba,local,w,h);check(['x','y','w','h'].every(k=>region[k]===s.crop[k]),'REGION_CHANGED');const crop=core.cropRect(rgba,local,w,h,region);check(hash(Buffer.from(crop.rgba))===s.rgbaSha256,'PIXELS_CHANGED');
  const raw=Float32Array.from(cloud,v=>v/255),clean=core.cleanCloudAlpha(raw,crop.w,crop.h),placed=core.placeBack(local,clean,crop,w,h,rgba);let adapterCalls=0;const audit=[];
  const result=await core.cloudMatting({rgba,alpha:local,width:w,height:h,consents:['faceCloudEnhance'],tool:'T1',adapter:{endpoint:'https://replay.tencentcloudapi.com',trustedHosts:['replay.tencentcloudapi.com'],kind:'offline-recording',call:async req=>{adapterCalls++;check(req.width===crop.w&&req.height===crop.h&&hash(Buffer.from(req.image,'base64'))===s.rgbaSha256,'REQUEST_CHANGED');return{alphaB64:cloud.toString('base64'),region:'CN',provider:'baidu'};}},audit:x=>audit.push(x)});
  const verdict=core.shouldAcceptCloudAlpha({cloudAlpha:clean,localAlpha:crop.alpha,provider:'baidu'});const expected=verdict.accept?placed:local;check(expected.length===result.alpha.length&&expected.every((v,i)=>v===result.alpha[i]),'PIPELINE_MISMATCH');check(adapterCalls===1,'ADAPTER_COUNT_INVALID');
  let cleaned=0,interiorChanged=0,outsidePositive=0;for(let i=0;i<raw.length;i++)if(raw[i]!==clean[i])cleaned++;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(x>=crop.x+6&&x<crop.x+crop.w-6&&y>=crop.y+6&&y<crop.y+crop.h-6){if(placed[i]!==clean[(y-crop.y)*crop.w+x-crop.x])interiorChanged++;}else if(x<crop.x||x>=crop.x+crop.w||y<crop.y||y>=crop.y+crop.h){if(placed[i]>0)outsidePositive++;}}
  check(interiorChanged===0,'INTERIOR_MUTATED');
  const stages={raw,clean,placed,returned:result.alpha};for(const [name,data]of Object.entries(stages)){check(stats(data).nonFinite===0,'NON_FINITE');fs.writeFileSync(path.join(folder,name+'.float32'),Buffer.from(data.buffer,data.byteOffset,data.byteLength),{flag:'wx'});}
  records.push({id:s.id,dimensions:[w,h],crop:s.crop,sourceRgbaSha256:hash(Buffer.from(rgba)),localAlphaSha256:hash(Buffer.from(local.buffer)),cloudAlphaSha256:rec.alphaSha256,adapterCalls,networkCalls:0,replayedProvider:'baidu',responseSource:'recorded-real-cloud-alpha',backend:result.backend,degraded:result.degraded,reason:result.reason||null,verdict,cleanedPixels:cleaned,interiorChangedByPlaceBack:interiorChanged,outsidePositivePixels:outsidePositive,stageStats:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,stats(v)])),audit});
 }
 const report={status:'PASS_REPLAY_INTEGRITY',scope:'实际core离线回放，非新云调用/真机/页面验收',networkCalls:0,records};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,networkCalls:0,records:records.map(r=>({id:r.id,backend:r.backend,reason:r.reason,cleanedPixels:r.cleanedPixels,interiorChanged:r.interiorChangedByPlaceBack}))}));
}
module.exports={stats};if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'FAIL',code:/^[A-Z_]+$/.test(e?.safeCode||'')?e.safeCode:'REPLAY_FAILED'}));process.exitCode=1;});
