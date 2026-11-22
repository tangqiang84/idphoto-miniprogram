#!/usr/bin/env python3
"""仅本机准备云增强对照，不执行网络请求。"""
import argparse, hashlib, json, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
IDS = ['RC09-USER-10', 'RC09-USER-08', 'RC09-USER-06']

def main():
    from PIL import Image
    p = argparse.ArgumentParser(); p.add_argument('--out', type=Path, required=True); args = p.parse_args()
    args.out.mkdir(exist_ok=False, parents=True)
    manifest = json.loads((ROOT/'docs/验证记录/RC-09-selection-20261105/photo-manifest.json').read_text())
    sources = {s['id']: s for s in manifest['samples']}; samples = []
    script = """const fs=require('fs'),m=require('./idphoto-miniprogram/src/core/mattingCloud');
const [src,mask,out,meta,w,h]=process.argv.slice(1);const rgba=new Uint8ClampedArray(fs.readFileSync(src));
const b=fs.readFileSync(mask),alpha=new Float32Array(Uint8Array.from(b).buffer);
const c=m.pickUploadRegion(rgba,alpha,+w,+h);if(c.full||c.w*c.h>=+w*+h)throw Error('FULL_IMAGE_FORBIDDEN');
const crop=m.cropRect(rgba,alpha,+w,+h,c);if(Math.min(crop.w,crop.h)<50||Math.max(crop.w,crop.h)>4096)throw Error('SIZE_INVALID');
fs.writeFileSync(out,Buffer.from(crop.rgba),{flag:'wx'});fs.writeFileSync(meta,JSON.stringify({x:crop.x,y:crop.y,w:crop.w,h:crop.h,mode:c.mode}),{flag:'wx'});"""
    for sid in IDS:
        src = ROOT/sources[sid]['path']; assert hashlib.sha256(src.read_bytes()).hexdigest() == sources[sid]['sha256']
        folder = args.out/sid; folder.mkdir(); image = Image.open(src).convert('RGBA'); w,h=image.size
        (folder/'source.rgba').write_bytes(image.tobytes())
        mask=ROOT/'docs/验证记录/RC-09-photo-device-20261105/device-run-02/rendered'/sid/'restored-alpha.float32'
        subprocess.run(['node','-e',script,str(folder/'source.rgba'),str(mask),str(folder/'crop.rgba'),str(folder/'crop.json'),str(w),str(h)],cwd=ROOT,check=True)
        crop=json.loads((folder/'crop.json').read_text());data=(folder/'crop.rgba').read_bytes();assert len(data)==crop['w']*crop['h']*4
        Image.frombytes('RGBA',(crop['w'],crop['h']),data).save(folder/'upload-preview.png')
        samples.append(dict(id=sid,sourceSha256=sources[sid]['sha256'],dimensions=[w,h],crop=crop,rgbaPath=sid+'/crop.rgba',rgbaSha256=hashlib.sha256(data).hexdigest(),bytes=len(data)))
    plan=dict(version='rc09-cloud-photo-v1',environment='baochengtang-d7g6ki1ch79dc2faa',function='matting',provider='baidu',maxCalls=3,retry=False,source='wechat-native-stable-derived-ROI',containsFullImages=False,uploadAuthorized=False,samples=samples)
    (args.out/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2))
    print(json.dumps({'samples':len(samples),'networkCalls':0,'plan':str(args.out/'plan.json')}))
if __name__=='__main__': main()
