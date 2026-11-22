#!/usr/bin/env python3
"""将已通过CPU的小图打入唯一诊断副本，不包含照片或网络下载。"""
import argparse
import base64
import hashlib
import json
import subprocess
import uuid
from pathlib import Path
from verify_runner import ROOT, snapshot, write_json

PAGE = '''import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import cases from './cases.json';
import { compareTensor } from './compareTensor';
import { sha256Async } from '../../core/sha256';
export default function CompatibilityProbe() {
 const [message,setMessage]=useState('运行官方小模型及算子对照，全部使用合成输入；不使用照片、不调用云服务或下载模型。');
 const [busy,setBusy]=useState(false);
 const control=useRef<any>({allowed:false,session:null,busy:false,version:0});
 const records=useRef<any[]>([]);
 const summary=()=>records.current.map(r=>r.id+': '+r.status+' '+r.code+'; 非有限='+String(r.nonFiniteCount??'-')+'; 最大差='+String(r.maxAbsError??'-')).join('\\n');
 const platform:any=Taro;
 const stop=()=>{const c=control.current;c.allowed=false;c.version++;try{c.session?.destroy();}catch{}c.session=null;};
 useEffect(()=>()=>stop(),[]);
 const run=async()=>{
  const c=control.current;if(c.busy)return;c.busy=true;c.allowed=true;const version=++c.version;setBusy(true);records.current=[];
  const runId='rc09-compat-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  let sequence=0;
  const check=()=>{if(!c.allowed||c.version!==version)throw {code:'CANCELLED'};};
  const save=(stage:string)=>{check();const info=platform.getSystemInfoSync();const report={runId,stage,time:Date.now(),source:'wechat-native',device:{platform:info.platform,model:info.model,system:info.system,version:info.version,SDKVersion:info.SDKVersion},records:records.current};platform.getFileSystemManager().writeFileSync(platform.env.USER_DATA_PATH+'/'+runId+'-'+sequence+++'.json',JSON.stringify(report),'utf8');};
  try {
   if(typeof platform.createInferenceSession!=='function')throw {code:'NATIVE_UNAVAILABLE'};
   for(const spec of cases as any[]) {
    check();setMessage(spec.id+'：校验模型');save(spec.id+'-start');
    const start=Date.now();
    try {
     const bytes=platform.base64ToArrayBuffer(spec.modelBase64);
     if(await sha256Async(new Uint8Array(bytes),{check})!==spec.sha256)throw {code:'MODEL_HASH_INVALID'};
     check();const path=platform.env.USER_DATA_PATH+'/'+runId+'-'+spec.id+'.onnx';
     platform.getFileSystemManager().writeFileSync(path,bytes);
     const session=platform.createInferenceSession({model:path,precisionLevel:4,allowNPU:false,allowQuantize:false,typicalShape:{[spec.inputName]:spec.inputShape}});c.session=session;
     await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject({code:'LOAD_TIMEOUT'}),15000);session.onLoad(()=>{clearTimeout(timer);resolve();});session.onError(()=>{clearTimeout(timer);reject({code:'LOAD_FAILED'});});});
     check();setMessage(spec.id+'：原生推理');save(spec.id+'-loaded');
     let timer:any;
     const nativeStart=Date.now();
     const output:any=await Promise.race([session.run({[spec.inputName]:{type:'float32',shape:spec.inputShape,data:new Float32Array(spec.input).buffer}}),new Promise((_,reject)=>{timer=setTimeout(()=>reject({code:'RUN_TIMEOUT'}),15000);})]).finally(()=>clearTimeout(timer));
     check();records.current.push({id:spec.id,sha256:spec.sha256,...compareTensor(output[spec.outputName],spec),runMs:Date.now()-nativeStart,totalMs:Date.now()-start});
    } catch(e:any) {
     check();const known=['MODEL_HASH_INVALID','LOAD_TIMEOUT','LOAD_FAILED','RUN_TIMEOUT'];const code=known.includes(e?.code)?e.code:'CASE_EXECUTION_FAILED';
     console.warn('[rc09-compat]',{code,traceId:runId,caseId:spec.id});records.current.push({id:spec.id,status:'FAIL',code,totalMs:Date.now()-start});
    } finally {try{c.session?.destroy();}catch{}c.session=null;}
    save(spec.id+'-finished');setMessage(summary());await new Promise(resolve=>setTimeout(resolve,0));
   }
   save('finished');setMessage('已结束 '+runId+'\\nPASS='+records.current.filter(r=>r.status==='PASS').length+'; FAIL='+records.current.filter(r=>r.status==='FAIL').length+'\\n'+summary()+'\\n仅兼容诊断，不代表MODNet或照片质量验收');
  } catch(e:any) {const code=e?.code==='CANCELLED'?'CANCELLED':e?.code==='NATIVE_UNAVAILABLE'?'NATIVE_UNAVAILABLE':'DIAGNOSTIC_FAILED';console.warn('[rc09-compat]',{code,traceId:runId});setMessage('诊断停止：'+code+'；可重新运行');}
  finally {try{c.session?.destroy();}catch{}c.session=null;c.busy=false;setBusy(false);}
 };
 return <View><Text style={{fontSize:'14px',color:'#111',whiteSpace:'pre-wrap'}} selectable>{message}</Text><Button disabled={busy} onClick={run}>同意并运行本地兼容对照</Button><Button onClick={()=>{stop();setMessage('已撤回；运行中结果不再接收');}}>撤回并释放</Button></View>;
}
'''

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cases',type=Path,required=True);args=parser.parse_args()
    specs=json.loads(args.cases.read_text())
    assert len(specs)>=8 and all(s['status']=='PASS' for s in specs)
    for s in specs:
        b=(args.cases.parent/s['file']).read_bytes();assert hashlib.sha256(b).hexdigest()==s['sha256']
        s['modelBase64']=base64.b64encode(b).decode()
    out=ROOT/'docs/验证记录/rc09-compatibility-builds'/('run-'+uuid.uuid4().hex[:12]);out.mkdir(parents=True)
    write_json(out/'production-inputs.json',snapshot(ROOT,out/'workspace'))
    app=out/'workspace/idphoto-miniprogram';page=app/'src/pages/rc09-compatibility';page.mkdir()
    (page/'index.tsx').write_text(PAGE);write_json(page/'cases.json',specs)
    (page/'compareTensor.js').write_text((ROOT/'工具链/rc09_compatibility_result.js').read_text())
    config=app/'src/app.config.ts';config.write_text(config.read_text().replace('pages: [',"pages: [\n    'pages/rc09-compatibility/index',"))
    steps={}
    for name,command in [('core',['npm','run','test:core']),('types',['node','node_modules/typescript/bin/tsc','--noEmit']),('lint',['npm','run','lint']),('build',['npm','run','build:weapp'])]:
        with (out/(name+'.log')).open('x') as log: steps[name]=subprocess.run(command,cwd=app,stdout=log,stderr=subprocess.STDOUT).returncode
    write_json(out/'report.json',dict(app=str(app),steps=steps,device='NOT_RUN',caseCount=len(specs),scope='官方MNIST及合成算子诊断，未含MobileNet或MODNet'))
    print(json.dumps(dict(out=str(out),steps=steps),ensure_ascii=False))
    return int(any(steps.values()))
if __name__=='__main__':raise SystemExit(main())
