'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(dir) {
  const planBytes=fs.readFileSync(path.join(dir,'待确认云验证计划.json'));
  const plan=JSON.parse(planBytes),approval=JSON.parse(fs.readFileSync(path.join(dir,'approval.json')));
  const inputs=JSON.parse(fs.readFileSync(path.join(dir,'inputs.json')));
  if(!approval.approved||!approval.allowPhotoUpload||approval.planSha256!==hash(planBytes)||approval.maxCalls!==3||approval.retry!==false||plan.totalMaxCalls!==3||inputs.length!==3||JSON.stringify(inputs.map(s=>s.id))!==JSON.stringify(approval.sampleIds))throw new Error('APPROVAL_INVALID');
  const ledger=path.join(dir,'dispatch-ledger.jsonl');
  const fd=fs.openSync(ledger,'wx');
  let mini;
  const result={time:new Date().toISOString(),planSha256:hash(planBytes),maxCalls:3,attempted:0,retry:false,records:[]};
  try {
    const prepared=inputs.map(s=>{const b=fs.readFileSync(path.join(dir,s.path));if(hash(b)!==s.sha256||Math.max(s.width,s.height)>768)throw new Error('INPUT_INVALID');return {...s,image:b.toString('base64')};});
    mini=await require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator').connect({wsEndpoint:'ws://127.0.0.1:9495'});
    for(const s of prepared){
      // 发送前记账；超时也占用一次，脚本不能复用同一授权重跑。
      fs.writeSync(fd,JSON.stringify({id:s.id,inputSha256:s.sha256,dispatchAt:new Date().toISOString()})+'\n');fs.fsyncSync(fd);result.attempted++;
      let timer;
      const data={action:'pose',consent:'faceCloudEnhance',suitConsent:'suitSwap',region:'CN',retain:false,train:false,purpose:'pose_keypoints',width:s.width,height:s.height,image:s.image};
      let r;
      try {r=await Promise.race([mini.evaluate(payload=>new Promise(resolve=>wx.cloud.callFunction({name:'matting',data:payload,success:r=>{const v=r.result||{};resolve({ok:v.ok===true,code:v.code,model:v.model,personCount:v.personCount,keypoints:v.keypoints,latencyMs:v.latencyMs,traceId:v.traceId});},fail:()=>resolve({ok:false,code:'SDK_FAILED'})})),data),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('POSE_TIMEOUT')),16000);})]);}
      finally{clearTimeout(timer);}
      const code=typeof r.code==='string'&&/^[A-Z_]+$/.test(r.code)?r.code:null;
      result.records.push({id:s.id,inputSha256:s.sha256,width:s.width,height:s.height,
        ok:r.ok===true,code,model:r.model==='baidu-body-analysis'?r.model:null,personCount:r.personCount===1?1:null,
        points:Array.isArray(r.keypoints)?r.keypoints.filter(p=>['left_shoulder','right_shoulder'].includes(p.name)).map(p=>({name:p.name,x:p.x,y:p.y,score:p.score})):[],
        latencyMs:typeof r.latencyMs==='number'?r.latencyMs:null,traceId:typeof r.traceId==='string'?r.traceId:null});
      if(!r.ok&&!['POSE_PERSON_COUNT','POSE_UNRELIABLE_SHOULDERS'].includes(code))break;
    }
    result.status=result.records.length===3&&result.records.every(r=>r.ok)?'PASS':'INCOMPLETE';
  }catch{result.status='BLOCKED';result.code='POSE_VALIDATION_STOPPED';}
  finally {
    fs.closeSync(fd);if(mini)try{await mini.disconnect();}catch{}
    fs.writeFileSync(path.join(dir,'real-pose-report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({status:result.status,attempted:result.attempted,records:result.records.map(r=>({id:r.id,ok:r.ok,code:r.code}))}));
  process.exitCode=result.status==='PASS'?0:3;
}
if(require.main===module)main(path.resolve(process.argv[2]||'')).catch(()=>{console.error('POSE_APPROVAL_OR_SETUP_INVALID');process.exitCode=2;});
