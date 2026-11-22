#!/usr/bin/env python3
"""真实原生alpha按产品后处理恢复原尺寸，仅本机输出QA成品。"""
import argparse,hashlib,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent


def main():
 parser=argparse.ArgumentParser();parser.add_argument('--device',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
 import numpy as np
 from PIL import Image
 report=json.loads((args.device/'report.json').read_text());manifest=json.loads((ROOT/'docs/验证记录/RC-09-selection-20261105/photo-manifest.json').read_text());sources={s['id']:s for s in manifest['samples']};args.out.mkdir(exist_ok=False);rows=[]
 script="const fs=require('fs'),m=require('./idphoto-miniprogram/src/core/mattingModel');const b=fs.readFileSync(process.argv[1]),a=new Float32Array(Uint8Array.from(b).buffer);const out=m.postprocess(a,m.getModelSpec('modnet-fp32'),Number(process.argv[3]),Number(process.argv[4]));fs.writeFileSync(process.argv[2],Buffer.from(out.buffer),{flag:'wx'});"
 for rec in report['records']:
  sid=rec['id'];source=ROOT/sources[sid]['path'];assert hashlib.sha256(source.read_bytes()).hexdigest()==rec['sourceSha256']==sources[sid]['sha256'];alpha=args.device/(sid+'-alpha.float32');assert hashlib.sha256(alpha.read_bytes()).hexdigest()==rec['alphaSha256'];folder=args.out/sid;folder.mkdir();image=Image.open(source).convert('RGB');w,h=image.size
  subprocess.run(['node','-e',script,str(alpha),str(folder/'restored-alpha.float32'),str(w),str(h)],cwd=ROOT,check=True)
  data=np.fromfile(folder/'restored-alpha.float32',np.float32).reshape(h,w);assert np.isfinite(data).all();mask=Image.fromarray(np.round(data*255).astype('uint8'));mask.save(folder/'alpha.png');image.save(folder/'source.png')
  for name,color in [('blue',(67,142,219)),('white',(255,255,255))]:Image.composite(image,Image.new('RGB',image.size,color),mask).save(folder/(name+'.png'))
  rows.append(dict(id=sid,dimensions=[w,h],sourceSha256=rec['sourceSha256'],alphaSha256=rec['alphaSha256'],numericalStatus=rec['fullComparison']['status'],visualStatus='NOT_REVIEWED',qualityApplicability='N/A-cartoon'if sid=='RC09-USER-07'else'real-photo',artifacts=sid))
 (args.out/'render-report.json').write_text(json.dumps(dict(source='wechat-native-debug-output',scope='实际产品core后处理+Pillow8bit-mask QA可视化，非T1/T2/T3导出全链',samples=rows),ensure_ascii=False,indent=2));print(json.dumps(dict(rendered=len(rows),out=str(args.out),visualPass=0),ensure_ascii=False))
if __name__=='__main__':main()
