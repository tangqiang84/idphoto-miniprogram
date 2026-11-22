#!/usr/bin/env python3
"""创建仅本地模型的隔离真机诊断工程；模型与照片不打入代码包。"""
import hashlib
import json
import subprocess
import uuid
from pathlib import Path
from verify_runner import snapshot, write_json
ROOT = Path(__file__).resolve().parent.parent

PAGE = '''import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import { configureEdgeModel, getEdgeSession, getModelStatus, setOrtRuntime } from '../../services/modelService';
import { createWechatRuntime } from '../../services/wechatInference';
const SHA = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9';
export default function NativeProbe() {
  const [ready, setReady] = useState(false);
  const [outputMetadata,setOutputMetadata]=useState<any>(null);
  const [message, setMessage] = useState('仅本地处理此前授权照片的测试输入，不调用云服务。请先同意本次测试。');
  useEffect(() => {
    let allowed = false;
    const app: any = Taro.getApp();
    const check = () => { if (!allowed) throw {code:'CONSENT_REQUIRED', message:'请先同意本次测试'}; };
    const runId='rc09-evidence-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    let sequence=0;
    const checkpoint=(stage:string) => {
      if(app.rc09.job) app.rc09.job.stage=stage;
      const p:any=Taro;
      const record={runId,sequence:sequence++,stage,time:Date.now(),phase:app.rc09.job?.phase||'idle',code:app.rc09.job?.code||null,result:app.rc09.job?.result||null,outputMetadata:app.rc09.job?.outputMetadata||null};
      p.getFileSystemManager().writeFileSync(p.env.USER_DATA_PATH+'/'+runId+'-'+record.sequence+'.json',JSON.stringify(record),'utf8');
      setMessage('本地阶段：'+stage+'；'+(app.rc09.job?.code||app.rc09.job?.result?.code||'')+'；耗时 '+(app.rc09.job?.startedAt?Date.now()-app.rc09.job.startedAt:0)+'ms');
    };
    app.rc09 = {
      startLocal() { return app.rc09.start('SYNTHETIC-NEUTRAL','rc09-00000000'); },
      start(id: string, prefix: string) {
        check();
        if (app.rc09.job?.phase === 'running') return {started:false,code:'JOB_BUSY'};
        app.rc09.job={phase:'running',stage:'queued',startedAt:Date.now()};
        checkpoint('queued');
        new Promise<void>(resolve=>setTimeout(resolve,0)).then(()=>app.rc09.run(id,prefix)).then(result=>{app.rc09.job={...app.rc09.job,phase:'finished',result};checkpoint(result.ok?'finished':'model-not-ready');},e=>{app.rc09.job={...app.rc09.job,phase:'failed',code:e.code||'MODEL_DIAGNOSTIC_FAILED',message:'本地模型测试失败'};checkpoint('failed');});
        return {started:true};
      },
      poll() { return app.rc09.job || {phase:'idle'}; },
      consent() { allowed = true; setReady(true); },
      capabilities() { const p: any = Taro; return {native: typeof p.createInferenceSession === 'function', status:getModelStatus()}; },
      async run(id: string, prefix: string) {
        check();
        if (!(id==='SYNTHETIC-NEUTRAL'||/^RC09-USER-\\d{2}$/.test(id)) || !/^rc09-[a-f0-9]+$/.test(prefix)) throw {code:'INPUT_INVALID'};
        configureEdgeModel({enabled:true,modelId:'modnet-fp32',weightUrl:'https://hf-mirror.com/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx',sha256:SHA,artifactRevision:'Xenova-fa2fa546-fp32',licenseEvidence:'RC09-community-model-card-apache-2.0',runtimeRevision:'wechat-native-unverified-device',timeoutMs:30000});
        checkpoint('service-cache-verify');
        setOrtRuntime(createWechatRuntime(Taro,{inputSize:512,timeoutMs:30000,onStage(stage:string){checkpoint(stage);},onOutputMetadata(metadata:any){if(app.rc09.job)app.rc09.job.outputMetadata=metadata;setOutputMetadata(metadata);checkpoint('native-output-metadata');}}));
        const model = await getEdgeSession({check,cacheOnly:true});
        if (!model.session) {setMessage('模型未就绪：'+model.reasonCode); return {ok:false,code:model.reasonCode};}
        const p: any = Taro;
        checkpoint('input-read');
        const data = id==='SYNTHETIC-NEUTRAL' ? new Float32Array(3*512*512) : new Float32Array(p.getFileSystemManager().readFileSync(p.env.USER_DATA_PATH+'/'+prefix+'-'+id+'.float32'));
        const start = Date.now();
        checkpoint('native-inference');
        const result = await model.session.run({input:new model.session.Tensor('float32',data,[1,3,512,512])});
        check();
        checkpoint('output-validation');
        const values = result.output.data;
        let min=Infinity,max=-Infinity,sum=0;
        for (const v of values) { min=Math.min(min,v);max=Math.max(max,v);sum+=v; }
        if (min<0 || max>1) throw {code:'MODEL_OUTPUT_RANGE'};
        app.rc09.lastOutput=p.arrayBufferToBase64(values.buffer.slice(values.byteOffset,values.byteOffset+values.byteLength));
        const evidence={ok:true,id,inputKind:id==='SYNTHETIC-NEUTRAL'?'synthetic-neutral':'authorized-photo',source:'wechat-native',sha256:SHA,length:values.length,min,max,mean:sum/values.length,latencyMs:Date.now()-start,qualityReview:'not-reviewed'};
        setMessage('真实原生推理已返回；视觉质量仍待评审');
        return evidence;
      },
      revoke() {allowed=false;configureEdgeModel({enabled:false});setReady(false);setMessage('已撤回测试授权，模型会话已释放');}
    };
    return () => {allowed=false;configureEdgeModel({enabled:false});delete app.rc09;};
  }, []);
  return <View className='page'><Text>RC-09 真机本地模型诊断（非生产页面）</Text><Text>{message}</Text>{outputMetadata?<View><Text selectable style={{fontSize:'14px',wordBreak:'break-all'}}>{JSON.stringify(outputMetadata,null,2)}</Text></View>:null}<Button className='rc09-consent' disabled={ready} onClick={()=>{const r=(Taro.getApp() as any).rc09;r.consent();r.startLocal();}}>同意并运行本地模型自检（合成输入）</Button><Button className='rc09-revoke' onClick={()=>{(Taro.getApp() as any).rc09.revoke();}}>撤回并释放模型</Button></View>;
}
'''

def main():
    out = ROOT / 'docs/验证记录/rc09-native-builds' / ('run-'+uuid.uuid4().hex[:12])
    out.mkdir(parents=True)
    write_json(out/'production-inputs.json', snapshot(ROOT,out/'workspace'))
    app=out/'workspace/idphoto-miniprogram'
    # 测试副本不调用云端；不改变生产部署或授权行为。
    (app/'src/services/cloudFnAdapter.ts').write_text("export interface CloudFnAdapterOpts {name?:string;authToken?:string;authorization?:any;}\nexport function makeCloudFnAdapter(_opts:CloudFnAdapterOpts={}) { return {endpoint:'cloud://CN',trustedHosts:['cloud://CN'],kind:'cloudfn',async call(_req:any){throw {code:'RC09_NETWORK_BLOCKED',message:'本地模型测试不调用云服务'};}};}\n")
    (app/'src/services/poseService.ts').write_text("export const POSE_TIMEOUT_MS=15000;\nexport function encodeCanvasToJpegB64(_c:any):null{return null;}\nexport async function requestPoseKeypoints(_r:any,_a?:any){return {ok:false,pose:null,reason:'RC09_NETWORK_BLOCKED',message:'本地模型测试不调用云服务'};}\n")
    page=app/'src/pages/rc09-native'
    page.mkdir()
    (page/'index.tsx').write_text(PAGE)
    p=app/'src/app.config.ts'
    p.write_text(p.read_text().replace('pages: [',"pages: [\n    'pages/rc09-native/index',"))
    with (out/'build.log').open('x') as log:
        code=subprocess.run(['npm','run','build:weapp'],cwd=str(app),stdout=log,stderr=subprocess.STDOUT).returncode
    files={str(p.relative_to(app/'dist')):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((app/'dist').rglob('*')) if p.is_file()}
    write_json(out/'build-files.json',files)
    write_json(out/'report.json',{'status':'PASS' if code==0 else 'FAIL','app':str(app),'code':code,'scope':'仅本地模型诊断副本，非生产/云能力验收','changes':['services/cloudFnAdapter','services/poseService','app.config','pages/rc09-native'],'buildId':hashlib.sha256((out/'build-files.json').read_bytes()).hexdigest()})
    print(json.dumps({'app':str(app),'report':str(out/'report.json'),'exitCode':code},ensure_ascii=False))
    return code
if __name__=='__main__':
    raise SystemExit(main())
