#!/usr/bin/env python3
"""用已校验的增量计划创建边界诊断工程；复用前轮隔离页生命周期。"""
import argparse
import hashlib
import json
import subprocess
import uuid
from pathlib import Path
from verify_runner import ROOT,snapshot,write_json
from prepare_rc09_compatibility import PAGE


def page_source():
    page=PAGE
    def replace(old,new):
        nonlocal page
        assert page.count(old)==1,old
        page=page.replace(old,new)
    replace("import cases from './cases.json';", "import plan from './boundary-plan.json';\nconst cases=plan.cases;")
    replace("import { compareTensor } from './compareTensor';", "import { rebuild, inspectBoundary } from './boundaryRuntime';")
    replace('运行官方小模型及算子对照，全部使用合成输入；不使用照片、不调用云服务或下载模型。','MODNet边界定位：仅使用已校验缓存及合成零输入；不下载模型、不使用照片、不调用云服务。')
    replace('String(r.maxAbsError??\'-\')', "String(r.maxSampleError??'-')")
    replace("if(typeof platform.createInferenceSession!=='function')throw {code:'NATIVE_UNAVAILABLE'};", """if(typeof platform.createInferenceSession!=='function')throw {code:'NATIVE_UNAVAILABLE'};
   setMessage('核验原始模型缓存，请保持前台');save('base-cache-read');
   const fs=platform.getFileSystemManager(),basePath=platform.env.USER_DATA_PATH+'/'+plan.baseFilename;
   let source:any;try{source=fs.readFileSync(basePath);}catch{throw {code:'MODEL_CACHE_MISSING'};}
   const base=new Uint8Array(source);if(base.length!==plan.baseBytes)throw {code:'MODEL_CACHE_INVALID'};
   save('base-cache-sha256');if(await sha256Async(base,{check})!==plan.baseSha256)throw {code:'MODEL_CACHE_INVALID'};
   check();save('base-cache-verified');""")
    replace('const bytes=platform.base64ToArrayBuffer(spec.modelBase64);', "const bytes=spec.id==='full-dynamic-control'?base:await rebuild(base,spec,(s:string)=>platform.base64ToArrayBuffer(s),check);")
    replace("if(await sha256Async(new Uint8Array(bytes),{check})!==spec.sha256)throw {code:'MODEL_HASH_INVALID'};", "if(spec.id!=='full-dynamic-control'&&await sha256Async(bytes,{check})!==spec.sha256)throw {code:'MODEL_HASH_INVALID'};")
    replace("check();const path=platform.env.USER_DATA_PATH+'/'+runId+'-'+spec.id+'.onnx';", "check();const path=spec.id==='full-dynamic-control'?basePath:platform.env.USER_DATA_PATH+'/'+runId+'-'+spec.id+'.onnx';")
    replace("platform.getFileSystemManager().writeFileSync(path,bytes);", "if(spec.id!=='full-dynamic-control')platform.getFileSystemManager().writeFileSync(path,bytes.buffer);")
    replace('data:new Float32Array(spec.input).buffer', 'data:new Float32Array(3*512*512).buffer')
    replace('...compareTensor(output[spec.outputName],spec)', '...inspectBoundary(output[spec.outputName],spec)')
    replace("e?.code==='NATIVE_UNAVAILABLE'?'NATIVE_UNAVAILABLE':'DIAGNOSTIC_FAILED'", "['NATIVE_UNAVAILABLE','MODEL_CACHE_MISSING','MODEL_CACHE_INVALID'].includes(e?.code)?e.code:'DIAGNOSTIC_FAILED'")
    replace('同意并运行本地兼容对照','同意并运行7项MODNet边界定位')
    replace('仅兼容诊断，不代表MODNet或照片质量验收','全量有限值＋32点抽样诊断，不代表全量数值或照片验收')
    return page


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--plan',type=Path,required=True);args=parser.parse_args()
    plan=json.loads(args.plan.read_text());assert len(plan['cases'])==7
    for spec in plan['cases']:
        if spec['id']=='full-dynamic-control':continue
        blob=(args.plan.parent/(spec['id']+'.onnx')).read_bytes();assert hashlib.sha256(blob).hexdigest()==spec['sha256']
    out=ROOT/'docs/验证记录/rc09-boundary-builds'/('run-'+uuid.uuid4().hex[:12]);out.mkdir(parents=True)
    write_json(out/'production-inputs.json',snapshot(ROOT,out/'workspace'))
    app=out/'workspace/idphoto-miniprogram';page=app/'src/pages/rc09-boundaries';page.mkdir()
    (page/'index.tsx').write_text(page_source());write_json(page/'boundary-plan.json',plan)
    (page/'boundaryRuntime.js').write_text((ROOT/'工具链/rc09_boundary_runtime.js').read_text())
    config=app/'src/app.config.ts';config.write_text(config.read_text().replace('pages: [',"pages: [\n    'pages/rc09-boundaries/index',"))
    steps={}
    for name,command in [('core',['npm','run','test:core']),('types',['node','node_modules/typescript/bin/tsc','--noEmit']),('lint',['npm','run','lint']),('build',['npm','run','build:weapp'])]:
        with(out/(name+'.log')).open('x')as log:steps[name]=subprocess.run(command,cwd=app,stdout=log,stderr=subprocess.STDOUT).returncode
    write_json(out/'report.json',dict(app=str(app),steps=steps,device='NOT_RUN',scope='7项边界有限值全检及32点抽样'))
    print(json.dumps(dict(out=str(out),steps=steps),ensure_ascii=False))
    return int(any(steps.values()))
if __name__=='__main__':raise SystemExit(main())
