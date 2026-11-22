#!/usr/bin/env python3
"""创建单观察模型、四组输入的隔离普通预览工程。"""
import argparse
import hashlib
import json
import subprocess
import uuid
from pathlib import Path
from verify_runner import ROOT,snapshot,write_json

PAGE='''import Taro from '@tarojs/taro';
import {useEffect,useRef,useState} from 'react';
import {View,Text,Button} from '@tarojs/components';
import plan from './observed-plan.json';
import {rebuild,inspectBoundary,inspectNormalization} from './boundaryRuntime';
import {cleanupAuthorizedStaticCopy} from './authorizedCleanup';
import {sha256Async} from '../../core/sha256';
export default function ObservedProbe(){
 const [message,setMessage]=useState('仅用已校验缓存、合成输入；四组完整图对照，无照片、下载或云调用。');
 const [busy,setBusy]=useState(false);
 const state=useRef<any>({allowed:false,busy:false,version:0,session:null,mounted:true,report:null});
 const p:any=Taro;
 const show=(s:string)=>{if(state.current.mounted)setMessage(s);};
 const stop=()=>{const c=state.current;c.allowed=false;c.version++;try{c.session?.destroy();}catch{}c.session=null;};
 useEffect(()=>()=>{state.current.mounted=false;stop();},[]);
 const run=async()=>{
  const c=state.current;if(c.busy)return;c.busy=true;c.allowed=true;const version=++c.version;setBusy(true);
  const runId='rc09-observed-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  const check=()=>{if(!c.allowed||c.version!==version)throw {code:'CANCELLED'};};
  const fs=p.getFileSystemManager(),root=p.env.USER_DATA_PATH;
  const info=p.getSystemInfoSync();const report:any={runId,experimentId:(plan as any).experimentId||'full-observed-v1',source:'wechat-native',time:Date.now(),stage:'start',device:{platform:info.platform,model:info.model,system:info.system,version:info.version,SDKVersion:info.SDKVersion},records:[],scope:'全量有限值与32点抽样，非照片验收'};c.report=report;
  let seq=0;
  const save=(stage:string)=>{check();report.stage=stage;fs.writeFileSync(root+'/'+runId+'-'+seq+++'.json',JSON.stringify(report),'utf8');};
  const summary=()=>report.records.map((r:any)=>r.id+': '+r.status+' '+(r.code||'')+'\\n'+(r.outputs||[]).map((o:any)=>'  '+o.nodeIndex+': '+o.status+' NaN='+String(o.nanCount??'-')+' Inf='+String(o.infCount??'-')+' 差='+(o.maxSampleError===null?'N/A':String(o.maxSampleError??'-'))).join('\\n')).join('\\n');
  const execute=async(path:string,spec:any,input:Float32Array)=>{
   let session:any,loadTimer:any,runTimer:any;
   try{
    check();session=p.createInferenceSession({model:path,precisionLevel:4,allowNPU:false,allowQuantize:false,typicalShape:{input:[1,3,512,512]}});c.session=session;
    await new Promise<void>((resolve,reject)=>{loadTimer=setTimeout(()=>reject({code:'LOAD_TIMEOUT'}),30000);session.onError(()=>{clearTimeout(loadTimer);reject({code:'LOAD_FAILED'});});session.onLoad(()=>{clearTimeout(loadTimer);resolve();});});
    check();save(spec.id+'-loaded');
    const result:any=await Promise.race([session.run({input:{type:'float32',shape:[1,3,512,512],data:input.buffer}}),new Promise((_,reject)=>{runTimer=setTimeout(()=>reject({code:'RUN_TIMEOUT'}),30000);})]);
    check();return {outputs:spec.outputs.map((out:any)=>({...out,samples:undefined,sampleIndices:undefined,...inspectBoundary(result[out.outputName],out)})),normalizationChecks:(spec.normalizationChecks||[]).map((pair:any)=>inspectNormalization(result[pair.inputName],result[pair.outputName],pair))};
   }finally{clearTimeout(loadTimer);clearTimeout(runTimer);try{session?.destroy();}catch{}if(c.session===session)c.session=null;}
  };
  try{
   check();if(typeof p.createInferenceSession!=='function')throw {code:'NATIVE_UNAVAILABLE'};
   save('base-read');show('核验原始缓存，请保持前台');
   const basePath=root+'/'+plan.baseFilename;let base:Uint8Array;
   try{base=new Uint8Array(fs.readFileSync(basePath));}catch{throw {code:'MODEL_CACHE_MISSING'};}
   if(base.length!==plan.baseBytes)throw {code:'MODEL_CACHE_INVALID'};
   save('base-sha256');if(await sha256Async(base,{check})!==plan.baseSha256)throw {code:'MODEL_CACHE_INVALID'};
   const authorization=(plan as any).authorizedCleanup;
   if(authorization){show('核验并清理已授权的1份旧静态副本');save('cleanup-start');await cleanupAuthorizedStaticCopy(fs,root,authorization,sha256Async,check,(event:any)=>{report.cleanup={...event,authorizationId:authorization.authorizationId};save('cleanup-'+event.status.toLowerCase());});}
   const modelPath=root+'/rc09-observed-'+plan.observed.sha256+'.onnx';let exists=false;
   try{fs.accessSync(modelPath);exists=true;}catch{}
   if(exists){save('observed-cache-sha256');const bytes=new Uint8Array(fs.readFileSync(modelPath));if(bytes.length!==plan.observed.byteLength||await sha256Async(bytes,{check})!==plan.observed.sha256)throw {code:'OBSERVED_CACHE_INVALID'};}
   else{
    show('核对本地文件预算');save('storage-budget');let total=0,count=0;
    const walk=(path:string)=>{for(const name of fs.readdirSync(path)){check();if(++count>10000)throw {code:'STORAGE_INSPECTION_LIMIT'};const file=path+'/'+name,stat=fs.statSync(file);if(stat.isDirectory())walk(file);else if(Number.isSafeInteger(stat.size)&&stat.size>=0)total+=stat.size;else throw {code:'STORAGE_INSPECTION_FAILED'};}};
    walk(root);report.storage={existingBytes:total,newModelBytes:plan.observed.byteLength,diagnosticBudgetBytes:plan.diagnosticFileBudgetBytes};
    if(total+plan.observed.byteLength>plan.diagnosticFileBudgetBytes)throw {code:'DIAGNOSTIC_STORAGE_BUDGET'};
    save('observed-rebuild');show('重建并核验唯一观察模型');
    const bytes=await rebuild(base,plan.observed,(s:string)=>p.base64ToArrayBuffer(s),check);
    save('observed-sha256');if(await sha256Async(bytes,{check})!==plan.observed.sha256)throw {code:'MODEL_HASH_INVALID'};
    check();fs.writeFileSync(modelPath,bytes.buffer);
   }
   save('models-ready');
   for(const spec of plan.cases as any[]){
    check();show(spec.id+'：生成输入与校验');save(spec.id+'-input');
    const input=new Float32Array(3*512*512);if(spec.inputKind==='ramp')for(let i=0;i<input.length;i++)input[i]=-1+2*i/(input.length-1);
    if(await sha256Async(new Uint8Array(input.buffer),{check})!==spec.inputSha256)throw {code:'INPUT_HASH_INVALID'};
    const start=Date.now();
    try{
     const {outputs,normalizationChecks}=await execute(spec.model==='original'?basePath:modelPath,spec,input);check();
     report.records.push({id:spec.id,modelSha256:spec.model==='original'?plan.baseSha256:plan.observed.sha256,inputSha256:spec.inputSha256,status:outputs.every((o:any)=>o.status==='PASS')&&normalizationChecks.every((o:any)=>o.status==='PASS')?'PASS':'FAIL',outputs,normalizationChecks,runAndLoadMs:Date.now()-start});
    }catch(e:any){check();const code=['LOAD_TIMEOUT','LOAD_FAILED','RUN_TIMEOUT'].includes(e?.code)?e.code:'CASE_EXECUTION_FAILED';console.warn('[rc09-observed]',{code,traceId:runId,caseId:spec.id});report.records.push({id:spec.id,status:'FAIL',code});}
    save(spec.id+'-finished');show(summary());await new Promise(resolve=>setTimeout(resolve,0));
   }
   save('finished');show('已结束 '+runId+'\\n'+(report.cleanup?'清理：'+report.cleanup.status+'\\n':'')+summary()+'\\n仅故障定位；可复制完整记录');
  }catch(e:any){const known=['CANCELLED','NATIVE_UNAVAILABLE','MODEL_CACHE_MISSING','MODEL_CACHE_INVALID','OBSERVED_CACHE_INVALID','MODEL_HASH_INVALID','INPUT_HASH_INVALID','DIAGNOSTIC_STORAGE_BUDGET','STORAGE_INSPECTION_LIMIT','STORAGE_INSPECTION_FAILED','CLEANUP_NOT_AUTHORIZED','CLEANUP_AUDIT_REQUIRED','CLEANUP_AUDIT_FAILED','CLEANUP_INSPECTION_FAILED','CLEANUP_SIZE_MISMATCH','CLEANUP_HASH_MISMATCH','CLEANUP_FILE_CHANGED','CLEANUP_DELETE_FAILED'];const code=known.includes(e?.code)?e.code:'DIAGNOSTIC_FAILED';console.warn('[rc09-observed]',{code,traceId:runId});report.code=code;if(code!=='CANCELLED')try{save('stopped');}catch{}show('已停止 '+code+'；不扩大清理范围或下载');}
  finally{try{c.session?.destroy();}catch{}c.session=null;c.busy=false;if(c.mounted)setBusy(false);}
 };
 return <View><Text selectable style={{fontSize:'12px',color:'#111',whiteSpace:'pre-wrap'}}>{message}</Text><Button disabled={busy} onClick={run}>同意并运行四组完整图对照</Button><Button onClick={()=>{stop();show('已撤回；迟到结果不再接收');}}>撤回并释放</Button><Button disabled={busy} onClick={()=>{if(state.current.report)p.setClipboardData({data:JSON.stringify(state.current.report)}).catch(()=>show('复制失败，请保留当前结果'));}}>复制诊断记录</Button></View>;
}
'''


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--plan',type=Path,required=True);args=parser.parse_args()
    plan=json.loads(args.plan.read_text());assert len(plan['cases'])==4
    assert hashlib.sha256((args.plan.parent/'full-observed.onnx').read_bytes()).hexdigest()==plan['observed']['sha256']
    out=ROOT/'docs/验证记录/rc09-observed-builds'/('run-'+uuid.uuid4().hex[:12]);out.mkdir(parents=True)
    write_json(out/'production-inputs.json',snapshot(ROOT,out/'workspace'))
    app=out/'workspace/idphoto-miniprogram';page=app/'src/pages/rc09-observed';page.mkdir()
    source=PAGE
    if plan.get('authorizedCleanup'):
        source=source.replace('仅用已校验缓存、合成输入；四组完整图对照，无照片、下载或云调用。','本次核验清理已授权的1份旧静态副本，再运行原图/稳定候选四组对照；不动其他模型、记录和照片，不下载。')
        source=source.replace('同意并运行四组完整图对照','执行已授权清理并运行候选对照')
    (page/'index.tsx').write_text(source);write_json(page/'observed-plan.json',plan)
    (page/'boundaryRuntime.js').write_text((ROOT/'工具链/rc09_boundary_runtime.js').read_text())
    (page/'authorizedCleanup.js').write_text((ROOT/'工具链/rc09_authorized_cleanup.js').read_text())
    config=app/'src/app.config.ts';config.write_text(config.read_text().replace('pages: [',"pages: [\n    'pages/rc09-observed/index',"))
    steps={}
    for name,command in [('core',['npm','run','test:core']),('types',['node','node_modules/typescript/bin/tsc','--noEmit']),('lint',['npm','run','lint']),('build',['npm','run','build:weapp'])]:
        with(out/(name+'.log')).open('x')as log:steps[name]=subprocess.run(command,cwd=app,stdout=log,stderr=subprocess.STDOUT).returncode
    write_json(out/'report.json',dict(app=str(app),steps=steps,device='NOT_RUN',scope='单观察图/原图×零/非恒定输入，4组定位'))
    print(json.dumps(dict(out=str(out),steps=steps),ensure_ascii=False))
    return int(any(steps.values()))
if __name__=='__main__':raise SystemExit(main())
