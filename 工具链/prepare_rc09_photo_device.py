#!/usr/bin/env python3
"""隔离照片内存诊断页；源照片、输入和alpha数组均不打包。"""
import argparse,json,subprocess,uuid
from pathlib import Path
from verify_runner import ROOT,snapshot,write_json
PAGE='''import Taro from '@tarojs/taro';
import {useEffect,useState} from 'react';
import {View,Text,Button} from '@tarojs/components';
import plan from './photo-plan.json';
import {createPhotoBuffer} from './photoBuffer';
import {inspectBoundary} from './boundaryRuntime';
import {createWechatRuntime} from '../../services/wechatInference';
import {sha256Async} from '../../core/sha256';
export default function PhotoDeviceProbe(){
 const [message,setMessage]=useState('RC-09 授权照片内存诊断。照片不在包内，不调用云开发或第三方推理；仅通过微信调试通道传入，由开发方执行。');
 useEffect(()=>{
  const p:any=Taro,app:any=Taro.getApp(),buffer=createPhotoBuffer(plan.samples);
  let allowed=false,epoch=0,session:any=null,runtime:any=null,output:Float32Array|null=null,outputTicket=0,job:any={phase:'idle'},sequence=0;
  const runId='rc09-photo-'+Date.now()+'-'+Math.random().toString(16).slice(2);
  const check=()=>{if(!allowed)throw {code:'CONSENT_REQUIRED'};};
  const idle=()=>{check();if(job.phase==='running')throw {code:'JOB_BUSY'};};
  const environment=()=>{const s=p.getSystemInfoSync();return{platform:s.platform,model:s.model,system:s.system,version:s.version,SDKVersion:s.SDKVersion};};
  const save=(stage:string)=>{job.stage=stage;const record={runId,time:Date.now(),environment:environment(),transport:'remote-debug-version-unconfirmed',job};p.getFileSystemManager().writeFileSync(p.env.USER_DATA_PATH+'/'+runId+'-'+sequence+++'.json',JSON.stringify(record),'utf8');setMessage(stage+'；'+JSON.stringify(job.result||{phase:job.phase,code:job.code||null}));};
  const schedule=(name:string,task:()=>Promise<any>)=>{idle();const version=epoch;job={phase:'running',stage:name};save(name);setTimeout(()=>{Promise.resolve().then(task).then(result=>{if(!allowed||version!==epoch)return;job={phase:'finished',result};save(name+'-finished');},e=>{if(!allowed||version!==epoch)return;const code=typeof e?.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(e.code)?e.code:'PHOTO_DIAGNOSTIC_FAILED';console.warn('[rc09-photo]',{code,traceId:runId});job={phase:'failed',code};save(name+'-failed');});},0);return{started:true};};
  const api:any={
   capabilities(){return{version:plan.version,modelReady:!!session,environment:environment(),phase:job.phase};},
   consent(){allowed=true;return{accepted:true,authorization:'RC09-user-photos-20261105'};},
   poll(){return job;},
   prepare(){return schedule('model-prepare',async()=>{check();const version=epoch;const guard=()=>{check();if(version!==epoch)throw {code:'SESSION_STALE'};};let bytes:any;try{bytes=new Uint8Array(p.getFileSystemManager().readFileSync(p.env.USER_DATA_PATH+'/'+plan.modelFilename));}catch{throw{code:'MODEL_CACHE_MISSING'};}if(bytes.length!==plan.modelBytes)throw{code:'MODEL_CACHE_INVALID'};save('model-sha256');if(await sha256Async(bytes,{check:guard})!==plan.modelSha256)throw{code:'MODEL_CACHE_INVALID'};bytes=null;guard();runtime=createWechatRuntime(Taro,{inputSize:512,timeoutMs:30000,onStage(stage:string){if(allowed&&version===epoch)save(stage);}});if(!runtime)throw{code:'NATIVE_UNAVAILABLE'};const loaded=await runtime.InferenceSession.create(p.env.USER_DATA_PATH+'/'+plan.modelFilename);if(!allowed||version!==epoch){loaded.release();throw{code:'SESSION_STALE'};}session=loaded;return{ready:true,modelSha256:plan.modelSha256};});},
   begin(id:string){idle();if(!session)throw{code:'MODEL_NOT_READY'};output=null;return buffer.begin(id);},
   append(ticket:number,offset:number,chunk:string){idle();return buffer.append(ticket,offset,new Uint8Array(p.base64ToArrayBuffer(chunk)));},
   run(ticket:number){return schedule('photo-'+ticket,async()=>{check();const version=epoch,guard=()=>{check();if(version!==epoch)throw{code:'SESSION_STALE'};buffer.check(ticket);};const sealed=buffer.seal(ticket);save('input-sha256');if(await sha256Async(sealed.bytes,{check:guard})!==sealed.spec.inputSha256)throw{code:'PHOTO_INPUT_HASH_INVALID'};guard();const start=Date.now();const result=await session.run({input:new runtime.Tensor('float32',new Float32Array(sealed.bytes.buffer),[1,3,512,512])});guard();const value=result.output;output=value.data;outputTicket=ticket;const comparison=inspectBoundary({type:'float32',shape:value.dims,data:value.data.buffer.slice(value.data.byteOffset,value.data.byteOffset+value.data.byteLength)},{...sealed.spec,samples:sealed.spec.expected});return{id:sealed.spec.id,ticket,sourceSha256:sealed.spec.sourceSha256,inputSha256:sealed.spec.inputSha256,modelSha256:plan.modelSha256,source:'wechat-native',environment:environment(),nativeRunMs:Date.now()-start,comparison,outputBytes:value.data.byteLength,quality:'NOT_REVIEWED'};});},
   readOutput(ticket:number,offset:number,length:number){idle();buffer.check(ticket);if(!output||outputTicket!==ticket||!Number.isInteger(offset)||!Number.isInteger(length)||offset<0||length<=0||length>32768||offset+length>output.byteLength)throw{code:'PHOTO_RESULT_INVALID'};return p.arrayBufferToBase64(output.buffer.slice(output.byteOffset+offset,output.byteOffset+offset+length));},
   revoke(){allowed=false;epoch++;buffer.clear();output=null;try{session?.release();}catch{}session=null;job={phase:'cancelled'};setMessage('已撤回并释放，输入及输出内存已丢弃');return{released:true};}
  };app.rc09Photos=api;
  return()=>{api.revoke();delete app.rc09Photos;};
 },[]);
 return <View><Text selectable style={{fontSize:'13px',color:'#111',whiteSpace:'pre-wrap'}}>{message}</Text><Button onClick={()=>{const api=(Taro.getApp()as any).rc09Photos;api.consent();if(!api.capabilities().modelReady)api.prepare();}}>同意本次授权照片本地诊断</Button><Button onClick={()=>{(Taro.getApp()as any).rc09Photos.revoke();}}>撤回并释放</Button></View>;
}
'''
def main():
 p=argparse.ArgumentParser();p.add_argument('--plan',type=Path,required=True);args=p.parse_args();plan=json.loads(args.plan.read_text());assert len(plan['samples'])==11
 out=ROOT/'docs/验证记录/rc09-photo-builds'/('run-'+uuid.uuid4().hex[:12]);out.mkdir(parents=True);write_json(out/'production-inputs.json',snapshot(ROOT,out/'workspace'))
 app=out/'workspace/idphoto-miniprogram';page=app/'src/pages/rc09-photo-device';page.mkdir();(page/'index.tsx').write_text(PAGE);write_json(page/'photo-plan.json',plan)
 for source,target in [('rc09_photo_buffer.js','photoBuffer.js'),('rc09_boundary_runtime.js','boundaryRuntime.js')]: (page/target).write_text((ROOT/'工具链'/source).read_text())
 config=app/'src/app.config.ts';config.write_text(config.read_text().replace('pages: [',"pages: [\n    'pages/rc09-photo-device/index',"));steps={}
 for name,cmd in [('core',['npm','run','test:core']),('types',['node','node_modules/typescript/bin/tsc','--noEmit']),('lint',['npm','run','lint']),('build',['npm','run','build:weapp'])]:
  with(out/(name+'.log')).open('x')as log:steps[name]=subprocess.run(cmd,cwd=app,stdout=log,stderr=subprocess.STDOUT).returncode
 write_json(out/'report.json',dict(app=str(app),steps=steps,device='NOT_RUN',scope='11份授权照片内存调试，图像数据未打包'));print(json.dumps(dict(out=str(out),steps=steps),ensure_ascii=False));return int(any(steps.values()))
if __name__=='__main__':raise SystemExit(main())
