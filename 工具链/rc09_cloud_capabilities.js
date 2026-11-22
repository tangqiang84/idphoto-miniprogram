'use strict';
const fs=require('fs'),path=require('path');
function assessCapabilities(value){
 if(!value||value.contractVersion!=='rc09-matting-capabilities-v1'||value.ok!==true)return{status:'BLOCKED',code:'CAPABILITY_ENDPOINT_UNAVAILABLE',configuredProvider:null,modelExecutionVerified:false,deploymentComplianceVerified:false};
 if(value.imageProcessingPerformed!==false||value.externalModelCalls!==0)return{status:'FAIL',code:'CAPABILITY_CONTRACT_INVALID',modelExecutionVerified:false,deploymentComplianceVerified:false};
 const selected=['baidu','shadow'].includes(value.configuredProvider)?value.configuredProvider:null;
 if(!selected)return{status:'FAIL',code:'CAPABILITY_PROVIDER_INVALID',modelExecutionVerified:false,deploymentComplianceVerified:false};
 const providers={};for(const id of ['baidu','shadow','birefnet']){const p=value.providers?.[id]||{};providers[id]={supported:p.supported===true,configured:p.configured===true,enabled:p.enabled===true,attemptable:p.attemptable===true,availability:['not-probed','local-code-present','not-integrated'].includes(p.availability)?p.availability:'unknown'};}
 const baidu=providers.baidu;
 if(!baidu.supported||typeof value.providers?.baidu?.enabled!=='boolean'||baidu.availability!=='not-probed'||!providers.shadow.supported||!providers.shadow.configured||providers.shadow.availability!=='local-code-present'||providers.birefnet.supported||providers.birefnet.configured||providers.birefnet.availability!=='not-integrated'||baidu.attemptable!==(baidu.configured&&baidu.enabled)||(selected==='baidu')!==baidu.attemptable)return{status:'FAIL',code:'CAPABILITY_CONFIGURATION_INCONSISTENT',modelExecutionVerified:false,deploymentComplianceVerified:false};
 return{status:'PASS',scope:'配置元数据，不是模型执行或质量验收',contractVersion:value.contractVersion,serviceVersion:value.serviceVersion==='rc09-capabilities-20261105'?value.serviceVersion:null,configuredProvider:selected,providers,modelExecutionVerified:false,qualityVerified:false,deploymentComplianceVerified:false,imageProcessingPerformed:false,externalModelCalls:0};
}
async function main(args=process.argv.slice(2)){
 const pos=args.indexOf('--out'),portPos=args.indexOf('--port');if(pos<0||!args[pos+1])throw{code:'ARGUMENT_INVALID'};const out=path.resolve(args[pos+1]);if(fs.existsSync(out))throw{code:'OUTPUT_EXISTS'};fs.mkdirSync(out,{recursive:true});let m,t;const report={time:new Date().toISOString(),scope:'无图、无第三方推理的CloudBase能力探测',request:{name:'matting',data:{action:'capabilities'}},containsPhotos:false};
 try{const a=require('/Users/tq/.workbuddy/binaries/node/workspace/node_modules/miniprogram-automator');m=await a.connect({wsEndpoint:'ws://127.0.0.1:'+Number(portPos<0?9495:args[portPos+1])});const raw=await Promise.race([m.evaluate(()=>new Promise(resolve=>{if(!wx.cloud||typeof wx.cloud.callFunction!=='function'){resolve({localCode:'CLOUD_SDK_UNAVAILABLE'});return;}wx.cloud.callFunction({name:'matting',data:{action:'capabilities'},success(res){resolve(res.result||null);},fail(e){resolve({localCode:'CLOUD_CALL_FAILED',errCode:typeof e.errCode==='number'?e.errCode:null});}});})),new Promise((_,reject)=>{t=setTimeout(()=>reject({code:'CLOUD_CAPABILITY_TIMEOUT'}),15000);})]);Object.assign(report,assessCapabilities(raw));}
 catch(e){report.status='BLOCKED';report.code=typeof e?.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'CLOUD_PROBE_UNAVAILABLE';}
 finally{clearTimeout(t);if(m)try{await m.disconnect();}catch{}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});}
 console.log(JSON.stringify({status:report.status,code:report.code||null,configuredProvider:report.configuredProvider||null,report:path.join(out,'report.json')}));return report.status==='PASS'?0:3;
}
module.exports={assessCapabilities,main};if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{console.error('CLOUD_CAPABILITY_SETUP_FAILED');process.exitCode=2;});
