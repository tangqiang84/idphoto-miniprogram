#!/usr/bin/env python3
"""为已获授权的单副本清理和稳定候选A/B生成固定计划。"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import onnxruntime as ort
from rc09_modnet_boundaries import BASE_SHA,delta


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--base',type=Path,required=True);parser.add_argument('--candidate',type=Path,required=True);parser.add_argument('--cleanup',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    base=args.base.read_bytes();candidate=args.candidate.read_bytes();assert hashlib.sha256(base).hexdigest()==BASE_SHA
    expected='5f0444985107e925a49070a906b09c0b03ffa04121361eccf97e958ea850b12a';assert hashlib.sha256(candidate).hexdigest()==expected
    manifest=json.loads(args.cleanup.read_text());assert len(manifest['files'])==1
    target=manifest['files'][0];assert target['filename']=='rc09-compat-1793878646675-cadc9d5a528bd8-full-static.onnx' and target['bytes']==25898737 and target['sha256']=='e621672ff91c0d9729eb87ac11dcd78683b1fc7d36c681d2fb55acdbc506e12d'
    args.out.mkdir(exist_ok=False);(args.out/'full-observed.onnx').write_bytes(candidate)
    sessions={'stable':ort.InferenceSession(candidate,providers=['CPUExecutionProvider']),'original':ort.InferenceSession(base,providers=['CPUExecutionProvider'])};cases=[];inputs={}
    for kind in ['zero','ramp']:
        size=3*512*512;data=np.zeros(size,np.float32)if kind=='zero'else(-1+2*np.arange(size,dtype=np.float64)/(size-1)).astype(np.float32);inputs[kind]=hashlib.sha256(data.tobytes()).hexdigest()
        for model in ['stable','original']:
            v=sessions[model].run(['output'],{'input':data.reshape(1,3,512,512)})[0];assert np.isfinite(v).all()
            indices=np.linspace(0,v.size-1,32,dtype=int).tolist();out=dict(outputName='output',nodeIndex=678 if model=='stable' else 486,outputShape=list(v.shape),sampleIndices=indices,samples=v.flatten()[indices].tolist(),atol=1e-3,rtol=1e-3)
            cases.append(dict(id=model+'-'+kind,model='observed'if model=='stable'else'original',inputKind=kind,inputSha256=inputs[kind],outputs=[out],normalizationChecks=[]))
    plan=dict(experimentId='stable-norm-axis-wise-ab-v1',baseFilename='matting-modnet-fp32.onnx',baseBytes=len(base),baseSha256=BASE_SHA,observed=dict(byteLength=len(candidate),sha256=expected,segments=delta(base,candidate)),authorizedCleanup=dict(authorized=True,authorizationId='user-reply-approved-one-static-copy-20261105',**target),cases=cases,diagnosticFileBudgetBytes=201326592,cpu=dict(status='PASS',onnxruntime=ort.__version__,inputHashes=inputs),device='NOT_RUN',scope='已授权单副本清理及原图/候选有限值全检和32点抽样，非照片/全量数值验收')
    (args.out/'observed-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2));print(json.dumps(dict(cases=4,candidateSha256=expected,cleanup='authorized-not-executed',device='NOT_RUN')))
if __name__=='__main__':main()
