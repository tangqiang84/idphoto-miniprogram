#!/usr/bin/env python3
"""独立U2Netp离线对照，遵循资产发布者预处理，不启用生产。"""
import argparse,json,hashlib,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent


def main():
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args()
 import numpy as np
 import onnxruntime as ort
 from PIL import Image
 model=ROOT/'docs/验证记录/RC-09-u2netp-compare-20261105/api-download.bin';blob=model.read_bytes();assert len(blob)==4574861 and hashlib.md5(blob).hexdigest()=='8e83ca70e441ab06c318d82300c84806';args.out.mkdir(exist_ok=False);s=ort.InferenceSession(blob,providers=['CPUExecutionProvider']);records=[]
 manifest=json.loads((ROOT/'docs/验证记录/RC-09-selection-20261105/photo-manifest.json').read_text())
 for sample in manifest['samples']:
  source=ROOT/sample['path'];assert hashlib.sha256(source.read_bytes()).hexdigest()==sample['sha256'];image=Image.open(source).convert('RGB');a=np.array(image.resize((320,320),Image.Resampling.LANCZOS));maximum=float(a.max());a=a/max(maximum,1e-6);x=((a-np.array([.485,.456,.406]))/np.array([.229,.224,.225])).transpose(2,0,1)[None].astype(np.float32)
  start=time.perf_counter();raw=s.run([s.get_outputs()[0].name],{s.get_inputs()[0].name:x})[0];elapsed=(time.perf_counter()-start)*1000;assert raw.shape==(1,1,320,320)and np.isfinite(raw).all();v=raw[0,0];low,high=float(v.min()),float(v.max());assert high>low;alpha=(v-low)/(high-low);folder=args.out/sample['id'];folder.mkdir();mask=Image.fromarray((alpha*255).astype('uint8')).resize(image.size,Image.Resampling.LANCZOS);mask.save(folder/'alpha.png');image.save(folder/'source.png')
  for name,color in [('blue',(67,142,219)),('white',(255,255,255))]:Image.composite(image,Image.new('RGB',image.size,color),mask).save(folder/(name+'.png'))
  records.append(dict(id=sample['id'],sourceSha256=sample['sha256'],inputMax=maximum,inputShape=list(x.shape),inputSha256=hashlib.sha256(x.tobytes()).hexdigest(),rawOutputShape=list(raw.shape),rawRange=[low,high],latencyMs=round(elapsed,2),technicalStatus='PASS',visualStatus='NOT_REVIEWED'))
 report=dict(modelSha256=hashlib.sha256(blob).hexdigest(),modelBytes=len(blob),inputName=s.get_inputs()[0].name,outputName=s.get_outputs()[0].name,preprocess='rembg: RGB/LANCZOS320/per-frame-max/ImageNet mean-std',postprocess='first-output minmax/LANCZOS restore',productGap='当前u2netp规格inputName与实物不符，且固定255/bilinear不同；未改生产',records=records,technicalPass=len(records),visualPass=0,provider='ONNX Runtime CPUExecutionProvider',runtime=ort.__version__,device='NOT_RUN',licenseAdmission='PENDING',scope='备选模型离线初审，不算正式质量/微信兼容通过')
 (args.out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(dict(technicalPass=len(records),visualPass=0,report=str(args.out/'report.json')),ensure_ascii=False))
if __name__=='__main__':main()
