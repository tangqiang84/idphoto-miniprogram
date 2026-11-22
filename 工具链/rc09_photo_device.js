'use strict';
// 已授权照片通过调试通道逐张传输；输入/输出驻手机内存，结果只保存在本机新目录。
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');
const PLAN_PATH=path.join(ROOT,'docs/验证记录/RC-09-photo-device-20261105/reference/photo-plan.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function inputBatch(data,offset){const parts=[];for(let at=offset;at<Math.min(offset+8*32768,data.length);at+=32768)parts.push({offset:at,data:data.subarray(at,at+32768).toString('base64')});return parts;}
function compareFull(actual,expected){
 if(actual.length!==1048576||expected.length!==actual.length)throw {code:'PHOTO_OUTPUT_SIZE_INVALID'};
 const a=new Float32Array(Uint8Array.from(actual).buffer),b=new Float32Array(Uint8Array.from(expected).buffer);let nonFiniteCount=0,mismatchCount=0,maxAbsError=0,sum=0,outOfRangeCount=0;
 for(let i=0;i<a.length;i++){if(!Number.isFinite(a[i])){nonFiniteCount++;continue;}if(a[i]<0||a[i]>1)outOfRangeCount++;const error=Math.abs(a[i]-b[i]);sum+=error;maxAbsError=Math.max(maxAbsError,error);if(error>1e-3+1e-3*Math.abs(b[i]))mismatchCount++;}
 return{status:nonFiniteCount||mismatchCount||outOfRangeCount?'FAIL':'PASS',nonFiniteCount,outOfRangeCount,mismatchCount,maxAbsError,meanAbsError:sum/a.length,coverage:'all-262144-elements'};
}
async function main(args=process.argv.slice(2)){
 const outArg=args.indexOf('--out'),portArg=args.indexOf('--port');if(outArg<0||!args[outArg+1])throw {code:'ARGUMENT_INVALID'};
 const out=path.resolve(args[outArg+1]);if(fs.existsSync(out))throw{code:'OUTPUT_EXISTS'};fs.mkdirSync(out,{recursive:true});let mini,sequence=0;
 const report={status:'BLOCKED',traceId:crypto.randomUUID(),time:new Date().toISOString(),stage:'connecting',scope:'授权照片真机调试原生全量数组对照；非视觉/性能/脱离调试验收',remoteMode:'version-not-independently-confirmed',modelSha256:null,records:[]};
 const write=()=>fs.writeFileSync(path.join(out,'stage-'+String(sequence++).padStart(4,'0')+'.json'),JSON.stringify(report,null,2),{flag:'wx'});
 async function rpc(task){let timer;try{return await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>reject({code:'PHOTO_RPC_TIMEOUT'}),10000);})]);}finally{clearTimeout(timer);}}
 async function identity(){const sdk=await rpc(()=>mini.systemInfo()),app=await rpc(()=>mini.evaluate(()=>getApp().rc09Photos?.capabilities()||null));if(!app||app.version!=='rc09-authorized-photo-memory-v1')throw{code:'PHOTO_PAGE_NOT_READY'};if(sdk.platform==='devtools'||app.environment.platform==='devtools')throw{code:'PHYSICAL_DEVICE_REQUIRED'};if(sdk.platform!==app.environment.platform||sdk.SDKVersion!==app.environment.SDKVersion)throw{code:'DEVICE_CONTEXT_MISMATCH'};return app.environment;}
 async function poll(maxMs=180000){const start=Date.now();let i=0;while(Date.now()-start<maxMs){const job=await rpc(()=>mini.evaluate(()=>getApp().rc09Photos.poll()));report.stage=job.stage||job.phase;if(job.phase==='finished')return job.result;if(job.phase==='failed')throw{code:job.code||'PHOTO_JOB_FAILED'};if(job.phase==='cancelled')throw{code:'PHOTO_JOB_CANCELLED'};if(i++%10===0)write();await new Promise(resolve=>setTimeout(resolve,500));}throw{code:'PHOTO_JOB_TIMEOUT'};}
 try{
  const automator=require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');mini=await rpc(()=>automator.connect({wsEndpoint:'ws://127.0.0.1:'+Number(portArg>=0?args[portArg+1]:9493)}));
  const caps=await rpc(()=>mini.evaluate(()=>getApp().rc09Photos?.capabilities()||null));if(!caps)throw{code:'PHOTO_PAGE_NOT_READY'};
  report.device=await identity();const plan=JSON.parse(fs.readFileSync(PLAN_PATH));report.modelSha256=plan.modelSha256;report.stage='model-prepare-check';write();await rpc(()=>mini.evaluate(()=>getApp().rc09Photos.consent()));
  if(caps.phase==='running')await poll(600000);
  const ready=await rpc(()=>mini.evaluate(()=>getApp().rc09Photos.capabilities()));
  if(!ready.modelReady){report.stage='model-prepare-request';write();const request=await rpc(()=>mini.evaluate(()=>{try{return{ok:true,result:getApp().rc09Photos.prepare()};}catch(e){return{ok:false,code:e.code||'PHOTO_PREPARE_FAILED'};}}));if(!request.ok&&request.code!=='JOB_BUSY')throw{code:request.code};await poll(600000);}
  report.device=await identity();
  for(const spec of plan.samples){
   if(!/^RC09-USER-\d{2}$/.test(spec.id))throw{code:'PHOTO_ID_INVALID'};report.stage=spec.id+':input';write();const environmentBefore=await identity();
   const data=fs.readFileSync(path.join(ROOT,'docs/验证记录/RC-09-stable-photos-20261105/cpu',spec.id,'input.float32'));if(data.length!==spec.inputBytes||hash(data)!==spec.inputSha256)throw{code:'LOCAL_INPUT_HASH_INVALID'};
   const ticket=(await rpc(()=>mini.evaluate(id=>getApp().rc09Photos.begin(id),spec.id))).ticket;
   for(let offset=0;offset<data.length;offset+=8*32768){const parts=inputBatch(data,offset);const received=await rpc(()=>mini.evaluate((t,batch)=>{let cursor=0;for(const part of batch)cursor=getApp().rc09Photos.append(t,part.offset,part.data);return cursor;},ticket,parts));if(received!==Math.min(offset+8*32768,data.length))throw{code:'PHOTO_OFFSET_MISMATCH'};if(offset%1048576===0){report.stage=spec.id+':transferred-'+received;write();}}
   await rpc(()=>mini.evaluate(t=>getApp().rc09Photos.run(t),ticket));const result=await poll();if(result.id!==spec.id||result.inputSha256!==spec.inputSha256||result.modelSha256!==plan.modelSha256)throw{code:'PHOTO_RESULT_BINDING_INVALID'};if(result.outputBytes!==1048576)throw{code:'PHOTO_OUTPUT_SIZE_INVALID'};
   const alpha=Buffer.alloc(result.outputBytes);for(let offset=0;offset<alpha.length;offset+=8*32768){const lengths=[];for(let at=offset;at<Math.min(offset+8*32768,alpha.length);at+=32768)lengths.push({offset:at,length:Math.min(32768,alpha.length-at)});const chunks=await rpc(()=>mini.evaluate((t,parts)=>parts.map(part=>getApp().rc09Photos.readOutput(t,part.offset,part.length)),ticket,lengths));if(chunks.length!==lengths.length)throw{code:'PHOTO_OUTPUT_CHUNK_INVALID'};chunks.forEach((s,i)=>{const chunk=Buffer.from(s,'base64');if(chunk.length!==lengths[i].length)throw{code:'PHOTO_OUTPUT_CHUNK_INVALID'};chunk.copy(alpha,lengths[i].offset);});}
   const environmentAfter=await identity();if(JSON.stringify(environmentAfter)!==JSON.stringify(environmentBefore))throw{code:'DEVICE_CHANGED'};
   fs.writeFileSync(path.join(out,spec.id+'-alpha.float32'),alpha,{flag:'wx'});const expected=fs.readFileSync(path.join(path.dirname(PLAN_PATH),spec.id+'-alpha.float32'));const fullComparison=compareFull(alpha,expected);report.records.push({...result,environmentBefore,environmentAfter,fullComparison,alphaSha256:hash(alpha),visualStatus:'NOT_REVIEWED'});write();console.log(JSON.stringify({id:spec.id,numericalStatus:fullComparison.status,completed:report.records.length,total:plan.samples.length}));
  }
  report.status=report.records.every(r=>r.fullComparison.status==='PASS')?'PASS':'FAIL';report.stage='finished';report.device=await identity();await rpc(()=>mini.evaluate(()=>getApp().rc09Photos.revoke()));report.releaseAcknowledged=true;
 }catch(e){report.status=report.records.length?'FAIL':'BLOCKED';report.failedStage=report.stage;report.stage='stopped';report.code=typeof e?.code==='string'?e.code:'PHOTO_DEVICE_DIAGNOSTIC_FAILED';if(mini){try{await rpc(()=>mini.evaluate(()=>getApp().rc09Photos?.revoke()));report.releaseAcknowledged=true;}catch{report.releaseAcknowledged=false;}}}
 finally{write();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});if(mini)try{await mini.disconnect();}catch{}}
 console.log(JSON.stringify({status:report.status,code:report.code||null,completed:report.records.length,report:path.join(out,'report.json')}));return report.status==='PASS'?0:3;
}
module.exports={main,compareFull,inputBatch};if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('PHOTO_DRIVER_SETUP_FAILED');process.exitCode=2;});
