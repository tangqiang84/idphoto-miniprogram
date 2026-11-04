'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..');
const required=['EDGE_ARTIFACT','EDGE_RUNTIME_DEVICE','CLOUD_DEPLOYMENT','QUALITY_COMPLEX','QUALITY_LIGHT_CLOTHES','QUALITY_HAIR','OFFLINE_DEVICE','LIVE_QUOTA_TIMEOUT','PHYSICAL_PERFORMANCE'];
function assess(manifest,root=ROOT){
 const errors=[],items=manifest?.items||[];const ids=items.map(i=>i.id);
 if(ids.length!==required.length||new Set(ids).size!==ids.length||required.some(id=>!ids.includes(id)))errors.push('缺少、重复或未知验收项');
 for(const item of items){if(!['PASS','FAIL','BLOCKED','SKIPPED'].includes(item.status)||!item.reason||!Array.isArray(item.evidence)){errors.push(item.id+':字段不完整');continue;}if(item.status==='PASS'){
  if(!item.evidence.length)errors.push(item.id+':PASS缺少独立报告');
  for(const e of item.evidence){const p=path.resolve(root,e.path||'');if(!p.startsWith(root+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()||!/^[a-f\d]{64}$/i.test(e.sha256||'')){errors.push(item.id+':报告/哈希无效');continue;}if(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==e.sha256)errors.push(item.id+':报告哈希不符');}
 }}
 const counts={PASS:0,FAIL:0,BLOCKED:0,SKIPPED:0};items.forEach(i=>{if(i.status in counts)counts[i.status]++;});
 return {status:errors.length||counts.FAIL?'FAIL':counts.BLOCKED||counts.SKIPPED?'BLOCKED':'PASS',counts,errors,items,scope:'证据存在/哈希与资源状态门禁，不自动判定人工质量或部署承诺真实，报告内容仍须审阅'};
}
function main(args=process.argv.slice(2)){if(args.length!==2||args[0]!=='--out')throw Error('ARGUMENT_INVALID');const out=path.resolve(args[1]);if(fs.existsSync(out))throw Error('OUTPUT_EXISTS');const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/RC-09资源验收清单.json'),'utf8'));const report={...assess(manifest),timestamp:new Date().toISOString()};fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,counts:report.counts}));return report.status==='PASS'?0:report.status==='BLOCKED'?3:1;}
module.exports={assess};if(require.main===module){try{process.exitCode=main();}catch{console.error('RC09_ACCEPTANCE_INVALID：参数或证据不可用');process.exitCode=2;}}
