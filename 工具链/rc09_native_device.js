'use strict';
// 真机远程连接后才执行；模型/输入只经调试通道写入手机沙盒，不调用抠图云服务。
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');
const BASE=path.join(ROOT,'docs/验证记录/RC-09-native-20261105');
const MODEL_SHA='07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9';
function transferOffset(info,bytes,reuse){
 if(!info.exists)return 0;
 if(!reuse)throw Error('DEVICE_OUTPUT_EXISTS');
 if(!Number.isInteger(info.size)||info.size<0||info.size>bytes.length)throw Error('DEVICE_CACHE_SIZE_INVALID');
 if(info.digest!==crypto.createHash('md5').update(bytes.subarray(0,info.size)).digest('hex'))throw Error('DEVICE_CACHE_PREFIX_MISMATCH');
 return info.size;
}
async function main(args=process.argv.slice(2)){
 const pos=args.indexOf('--out');if(args.length!==2||pos!==0)throw Error('ARGUMENT_INVALID');
 const out=path.resolve(args[1]);if(fs.existsSync(out))throw Error('OUTPUT_EXISTS');fs.mkdirSync(out,{recursive:true});
 const report={status:'BLOCKED',phase:'connecting',traceId:crypto.randomUUID(),timestamp:new Date().toISOString(),scope:'微信原生推理真机诊断；不代表完整产品或视觉验收',results:[]};
 const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
 let mini;
 try {
  const automator=require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');
  mini=await automator.connect({wsEndpoint:'ws://127.0.0.1:9481'});
  await mini.reLaunch('/pages/rc09-native/index');
  const initial=await mini.systemInfo();report.initialEnvironment={platform:initial.platform,system:initial.system,SDKVersion:initial.SDKVersion};
  if(initial.platform==='devtools') {
    report.phase='waiting-manual-scan'; report.code='DEVICE_SCAN_REQUIRED'; write();
    console.log(JSON.stringify({status:'BLOCKED',code:report.code,report:path.join(out,'report.json')})); return 3;
  }
  report.phase='device-connected';report.device=await mini.systemInfo();
  if(report.device.platform==='devtools')throw Error('PHYSICAL_DEVICE_REQUIRED');
  write();await mini.reLaunch('/pages/rc09-native/index');
  let page=await mini.currentPage();const consent=await page.$('.rc09-consent');if(!consent)throw Error('CONSENT_CONTROL_MISSING');await mini.evaluate(()=>getApp().rc09.consent());
  report.capabilities=await mini.evaluate(()=>getApp().rc09.capabilities());
  if(!report.capabilities.native)throw Error('NATIVE_INFERENCE_UNAVAILABLE');
  const sandbox=await mini.evaluate(()=>wx.env.USER_DATA_PATH),prefix='rc09-'+crypto.randomBytes(8).toString('hex');
  async function put(name,bytes,reuse=false){
   const target=sandbox+'/'+name;
   report.phase='file-existence-check:'+name;write();
   const info=await mini.evaluate(p=>new Promise(resolve=>wx.getFileSystemManager().getFileInfo({filePath:p,digestAlgorithm:'md5',success(r){resolve({exists:true,size:r.size,digest:r.digest});},fail(){resolve({exists:false});}})),target);
   const offset=transferOffset(info,bytes,reuse);
   for(let i=offset;i<bytes.length;i+=32*1024){report.phase='file-write:'+name+':'+i;write();const chunk=bytes.subarray(i,i+32*1024).toString('base64');await mini.evaluate((p,b,append)=>{const f=wx.getFileSystemManager(),data=wx.base64ToArrayBuffer(b);if(append)f.appendFileSync(p,data);else f.writeFileSync(p,data);return true;},target,chunk,i>0);}

  }
  const model=fs.readFileSync(path.join(BASE,'modnet-community-fp32.onnx'));if(crypto.createHash('sha256').update(model).digest('hex')!==MODEL_SHA)throw Error('MODEL_SHA_MISMATCH');
  report.phase='transferring-model';write();await put('matting-modnet-fp32.onnx',model,true);
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/验证记录/RC-09-selection-20261105/photo-manifest.json'),'utf8'));
  report.sampleLimit=1;
  for(const sample of manifest.samples.slice(0,1)){
   report.phase='running-'+sample.id;write();
   const input=fs.readFileSync(path.join(BASE,'cpu-real-v1',sample.id,'input.float32'));await put(prefix+'-'+sample.id+'.float32',input);
   report.phase='input-transferred-'+sample.id;write();
   const started=await mini.evaluate((id,p)=>getApp().rc09.start(id,p),sample.id,prefix);
   if(!started.started)throw Error('DEVICE_JOB_BUSY');
   let job;
   for(let i=0;i<90;i++){
    job=await mini.evaluate(()=>getApp().rc09.poll());report.phase=sample.id+':'+(job.stage||job.phase);write();
    if(job.phase==='finished'||job.phase==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
   if(job.phase!=='finished')throw Error(job.code||'DEVICE_JOB_TIMEOUT');
   const result=job.result;report.results.push(result);write();
   if(!result.ok)throw Error(result.code||'MODEL_RUN_FAILED');
   const encoded=await mini.evaluate(()=>getApp().rc09.lastOutput);fs.writeFileSync(path.join(out,sample.id+'.float32'),Buffer.from(encoded,'base64'),{flag:'wx'});
  }
  await mini.evaluate(()=>getApp().rc09.revoke());
  report.released=await mini.evaluate(()=>getApp().rc09.capabilities().status.hasSession===false);
  if(!report.released)throw Error('MODEL_RELEASE_FAILED');
  report.status='PASS';report.phase='finished';write();console.log(JSON.stringify({status:report.status,count:report.results.length,report:path.join(out,'report.json')}));
 } catch(e){report.failedPhase=report.phase;
  report.setupDiagnostic=String(e.message||'').replace(/[A-Za-z0-9+\/=]{80,}/g,'[redacted]').slice(0,200);
  report.phase='stopped';report.code=/^[A-Z0-9_]+$/.test(e.message||'')?e.message:'DEVICE_DIAGNOSTIC_FAILED';report.status='BLOCKED';write();console.log(JSON.stringify({status:report.status,code:report.code,report:path.join(out,'report.json')}));return 3;}
 finally {if(mini){try{await mini.disconnect();}catch{}}}
 return 0;
}
module.exports={main,transferOffset};
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('RC09_DEVICE_SETUP_FAILED');process.exitCode=2;});
