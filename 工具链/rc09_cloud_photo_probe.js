'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const IDS=['RC09-USER-10','RC09-USER-08','RC09-USER-06'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function validatePlan(plan,approval,planSha){
 if(!approval||approval.approved!==true||approval.planSha256!==planSha||approval.maxCalls!==3||approval.allowExistingServiceCharges!==true||approval.allowBaiduPhotoUpload!==true) return 'CLOUD_APPROVAL_REQUIRED';
 if(plan.version!=='rc09-cloud-photo-v1'||plan.environment!=='baochengtang-d7g6ki1ch79dc2faa'||plan.function!=='matting'||plan.provider!=='baidu'||plan.maxCalls!==3||plan.retry!==false||plan.containsFullImages!==false||!Array.isArray(plan.samples)||plan.samples.length!==3||JSON.stringify(plan.samples.map(s=>s.id))!==JSON.stringify(IDS)||JSON.stringify(approval.sampleIds)!==JSON.stringify(IDS)) return 'CLOUD_PLAN_INVALID';
 for(const s of plan.samples){const c=s.crop,d=s.dimensions;if(!c||!Array.isArray(d)||d.length!==2||![...d,c.x,c.y,c.w,c.h].every(Number.isInteger)||d.some(n=>n<=0)||c.x<0||c.y<0||c.w<50||c.h<50||c.w>4096||c.h>4096||c.x+c.w>d[0]||c.y+c.h>d[1]||c.w*c.h>=d[0]*d[1]||s.bytes!==c.w*c.h*4||s.bytes>4*1024*1024||s.rgbaPath!==s.id+'/crop.rgba'||!/^[a-f0-9]{64}$/.test(s.rgbaSha256))return 'CLOUD_CROP_INVALID';}
 return null;
}
async function runBatch({plan,approval,planSha,load,call,save,timeoutMs=20000}){
 const error=validatePlan(plan,approval,planSha);if(error)return{status:'BLOCKED',code:error,calls:0,records:[]};
 // 全部输入先核验，避免部分上传后才发现本地资产已变。
 const inputs=[];for(const s of plan.samples){const b=load(s);if(b.length!==s.bytes||sha(b)!==s.rgbaSha256)return{status:'BLOCKED',code:'CLOUD_INPUT_CHANGED',calls:0,records:[]};inputs.push(b);}
 const report={status:'PASS',scope:'三张裁剪区域真实云增强技术验证；视觉另审',calls:0,records:[],automaticRetries:0};
 for(let i=0;i<plan.samples.length;i++){
  const s=plan.samples[i];let timer;report.calls++;const started=Date.now();
  try{
   const r=await Promise.race([call({consent:'faceCloudEnhance',region:'CN',retain:false,train:false,provider:'baidu',image:inputs[i].toString('base64'),width:s.crop.w,height:s.crop.h}),new Promise((_,reject)=>{timer=setTimeout(()=>reject({safeCode:'CLOUD_PROBE_TIMEOUT'}),timeoutMs);})]);
   if(!r||r.provider!=='baidu'){report.records.push({id:s.id,status:'FAIL',code:'CLOUD_MODEL_NOT_CONFIRMED',latencyMs:Date.now()-started});report.status='FAIL';break;}
   if(typeof r.alphaB64!=='string'||r.alphaB64.length>4*Math.ceil(s.crop.w*s.crop.h/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(r.alphaB64))throw{safeCode:'CLOUD_ALPHA_INVALID'};
   const alpha=Buffer.from(r.alphaB64,'base64');if(alpha.length!==s.crop.w*s.crop.h)throw{safeCode:'CLOUD_ALPHA_INVALID'};
   save(s,alpha);report.records.push({id:s.id,status:'PASS',provider:'baidu',alphaBytes:alpha.length,alphaSha256:sha(alpha),latencyMs:Date.now()-started,visualStatus:'NOT_REVIEWED'});
  }catch(e){report.status='FAIL';report.records.push({id:s.id,status:'FAIL',code:['CLOUD_PROBE_TIMEOUT','CLOUD_ALPHA_INVALID'].includes(e?.safeCode)?e.safeCode:'CLOUD_PROBE_FAILED',latencyMs:Date.now()-started});break;}finally{clearTimeout(timer);}
 }
 report.notRun=plan.samples.slice(report.calls).map(s=>s.id);return report;
}
async function main(args){
 const get=k=>{const p=args.indexOf(k);return p>=0?args[p+1]:null;};const planPath=get('--plan'),authPath=get('--approval'),outPath=get('--out');if(!planPath||!authPath||!outPath)throw{safeCode:'ARGUMENT_INVALID'};
 const bytes=fs.readFileSync(planPath),plan=JSON.parse(bytes),approval=JSON.parse(fs.readFileSync(authPath));const err=validatePlan(plan,approval,sha(bytes));if(err)throw{safeCode:err};
 const out=path.resolve(outPath);if(fs.existsSync(out))throw{safeCode:'OUTPUT_EXISTS'};fs.mkdirSync(out,{recursive:true});let m;
 try{const a=require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');m=await a.connect({wsEndpoint:'ws://127.0.0.1:'+Number(get('--port')||9495)});
 const report=await runBatch({plan,approval,planSha:sha(bytes),load:s=>fs.readFileSync(path.resolve(path.dirname(planPath),s.rgbaPath)),save:(s,b)=>fs.writeFileSync(path.join(out,s.id+'-alpha.uint8'),b,{flag:'wx'}),call:data=>m.evaluate(payload=>new Promise(resolve=>wx.cloud.callFunction({name:'matting',data:payload,success:r=>{const v=r.result||{};resolve({provider:v.provider,alphaB64:v.alphaB64})},fail:()=>resolve({provider:'unavailable'})})),data)});
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,time:new Date().toISOString(),planSha256:sha(bytes),complianceVerified:false},null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,calls:report.calls,report:path.join(out,'report.json')}));return report.status==='PASS'?0:3;
 }finally{if(m)await m.disconnect();}
}
module.exports={validatePlan,runBatch};if(require.main===module)main(process.argv.slice(2)).then(c=>{process.exitCode=c;}).catch(e=>{console.error(JSON.stringify({status:'BLOCKED',code:['ARGUMENT_INVALID','CLOUD_APPROVAL_REQUIRED','CLOUD_PLAN_INVALID','CLOUD_CROP_INVALID','OUTPUT_EXISTS'].includes(e?.safeCode)?e.safeCode:'CLOUD_PROBE_SETUP_FAILED'}));process.exitCode=2;});
