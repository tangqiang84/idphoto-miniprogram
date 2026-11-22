#!/usr/bin/env python3
"""授权照片仅在本地运行；输出可打包的摘要/数值参考，不打包照片。"""
import argparse,json,hashlib
from pathlib import Path
import numpy as np
import onnxruntime as ort
ROOT=Path(__file__).resolve().parent.parent


def main():
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args();args.out.mkdir(exist_ok=False)
 model=ROOT/'docs/验证记录/RC-09-stable-norm-20261105/cpu-axis-wise/stable-norm.onnx';sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest();model_sha=sha(model);assert model_sha=='5f0444985107e925a49070a906b09c0b03ffa04121361eccf97e958ea850b12a'
 session=ort.InferenceSession(str(model),providers=['CPUExecutionProvider']);manifest=json.loads((ROOT/'docs/验证记录/RC-09-selection-20261105/photo-manifest.json').read_text());samples=[]
 for sample in manifest['samples']:
  assert sha(ROOT/sample['path'])==sample['sha256']
  inp=ROOT/'docs/验证记录/RC-09-stable-photos-20261105/cpu'/sample['id']/'input.float32';assert sha(inp)==sha(ROOT/'docs/验证记录/RC-09-native-20261105/cpu-real-v1'/sample['id']/'input.float32')
  x=np.fromfile(inp,np.float32);assert x.size==3*512*512;y=session.run(['output'],{'input':x.reshape(1,3,512,512)})[0];assert np.isfinite(y).all();y.tofile(args.out/(sample['id']+'-alpha.float32'));indices=np.linspace(0,y.size-1,32,dtype=int).tolist()
  samples.append(dict(id=sample['id'],sourceSha256=sample['sha256'],inputBytes=inp.stat().st_size,inputSha256=sha(inp),outputShape=[1,1,512,512],sampleIndices=indices,expected=y.flatten()[indices].tolist(),atol=1e-3,rtol=1e-3,qualityApplicability='cartoon-not-real-person'if sample['id']=='RC09-USER-07'else'pending-visual-review'))
 samples.sort(key=lambda s:(s['id']!='RC09-USER-10',s['id']))
 plan=dict(version='rc09-authorized-photo-memory-v1',modelSha256=model_sha,modelBytes=model.stat().st_size,modelFilename='rc09-observed-'+model_sha+'.onnx',samples=samples,scope='元数据/CPU数值参考；照片及输入Tensor不得打包',runtime=ort.__version__)
 (args.out/'photo-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2));print(json.dumps(dict(samples=len(samples),first=samples[0]['id'],photosInPackage=False)))
if __name__=='__main__':main()
