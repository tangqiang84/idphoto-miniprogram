'use strict';
// 只下载公共服装素材并验证无授权姿态拒绝；不发送照片、不触发百度推理。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const manifest=require('../idphoto-miniprogram/cloudfunctions/matting/suit-assets/manifest.json');
async function main(output) {
  fs.mkdirSync(output,{recursive:false});
  const report={time:new Date().toISOString(),photoUploads:0,externalModelCalls:0,scope:'模板及模型权重真实传输、姿态授权拒绝，不执行照片推理',cases:[]};
  let mini;
  try {
    mini=await require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator').connect({wsEndpoint:'ws://127.0.0.1:9495'});
    const call=async data=>{
      let timer;
      try {return await Promise.race([mini.evaluate(payload=>new Promise(resolve=>wx.cloud.callFunction({name:'matting',data:payload,success:r=>resolve(r.result||{}),fail:()=>resolve({error:'CLOUD_CALL_FAILED'})})),data),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PROBE_TIMEOUT')),15000);})]);}
      finally {clearTimeout(timer);}
    };
    const denied=await call({action:'pose'});
    report.cases.push({id:'pose-no-consent',status:denied.code==='CONSENT_REQUIRED'?'PASS':'FAIL',code:denied.code||'UNKNOWN'});
    for(const item of [...manifest,require('../idphoto-miniprogram/cloudfunctions/matting/suit-parsing-model/manifest.json')]){
      const parts=[];
      for(let chunk=0;chunk<Math.ceil(item.bytes/(512*1024));chunk++){
        const r=await call({action:item.id==='selfie-clothing-6'?'suit-parsing-model':'suit-template',consent:'suitSwap',templateId:item.id,chunk});
        if(!r.ok||r.templateId!==item.id||r.chunk!==chunk||r.sha256!==item.sha256)throw new Error('ASSET_RESPONSE_INVALID');
        parts.push(Buffer.from(r.dataB64,'base64'));
      }
      const bytes=Buffer.concat(parts),digest=crypto.createHash('sha256').update(bytes).digest('hex');
      report.cases.push({id:item.id,status:bytes.length===item.bytes&&digest===item.sha256?'PASS':'FAIL',bytes:bytes.length,sha256:digest});
    }
    report.status=report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';
  } catch {report.status='BLOCKED';report.code='RC10_CLOUD_PROBE_UNAVAILABLE';}
  finally {
    if(mini)try{await mini.disconnect();}catch{}
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({status:report.status,cases:report.cases.length,photoUploads:0,externalModelCalls:0}));
  process.exitCode=report.status==='PASS'?0:3;
}
if(require.main===module)main(path.resolve(process.argv[2]||'rc10-cloud-probe')).catch(()=>{console.error('RC10_CLOUD_PROBE_SETUP_FAILED');process.exitCode=2;});
