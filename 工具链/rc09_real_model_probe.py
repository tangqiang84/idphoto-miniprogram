#!/usr/bin/env python3
"""固定授权素材真实CPU推理；复用产品预处理，不输出照片到日志，不代表微信/视觉验收。"""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    model = Path(args.model).resolve()
    if hashlib.sha256(model.read_bytes()).hexdigest() != args.sha256:
        raise ValueError('MODEL_SHA_MISMATCH')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
    assert len(session.get_inputs()) == 1 and session.get_inputs()[0].name == 'input'
    assert len(session.get_outputs()) == 1 and session.get_outputs()[0].name == 'output'
    records = []
    for sample in json.loads(Path(args.manifest).read_text())['samples']:
        source = ROOT / sample['path']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == sample['sha256']
        folder = out / sample['id']
        folder.mkdir()
        image = Image.open(source).convert('RGBA')
        w, h = image.size
        (folder / 'source.rgba').write_bytes(image.tobytes())
        # 调用实际产品预处理，不在Python重复实现一个近似输入。
        script = "const fs=require('fs'),m=require('./idphoto-miniprogram/src/core/mattingLocal'),s=require('./idphoto-miniprogram/src/core/mattingModel').getModelSpec('modnet-fp32');const b=fs.readFileSync(process.argv[1]);const t=m.preprocess(new Uint8ClampedArray(b.buffer,b.byteOffset,b.length),Number(process.argv[3]),Number(process.argv[4]),s);fs.writeFileSync(process.argv[2],Buffer.from(t.buffer,t.byteOffset,t.byteLength));"
        subprocess.run(['node', '-e', script, str(folder / 'source.rgba'), str(folder / 'input.float32'), str(w), str(h)], cwd=str(ROOT), check=True)
        x = np.fromfile(folder / 'input.float32', dtype=np.float32).reshape(1, 3, 512, 512)
        start = time.perf_counter()
        alpha = session.run(['output'], {'input': x})[0]
        latency = (time.perf_counter() - start) * 1000
        assert alpha.shape == (1, 1, 512, 512) and np.isfinite(alpha).all()
        amin, amax = float(alpha.min()), float(alpha.max())
        assert amin >= 0 and amax <= 1
        matte = Image.fromarray((alpha[0, 0] * 255).round().astype('uint8')).resize((w, h), Image.Resampling.BILINEAR)
        matte.save(folder / 'alpha.png')
        for label, color in [('white', (255,255,255)), ('blue', (67,142,219))]:
            composite = Image.composite(image.convert('RGB'), Image.new('RGB', image.size, color), matte)
            composite.save(folder / (label + '.png'))
        image.thumbnail((480, 640))
        image.save(folder / 'source-preview.png')
        records.append({'id': sample['id'], 'sourceSha256': sample['sha256'], 'dimensions': [w,h], 'input': [1,3,512,512], 'output': list(alpha.shape), 'alphaRange': [amin,amax], 'latencyMs': round(latency,2), 'provider':'onnxruntime-cpu', 'technicalStatus':'PASS', 'visualStatus':'NOT_REVIEWED', 'artifacts':str(folder.relative_to(out))})
    report = {'scope':'真实CPU模型执行/产品预处理；非微信、非实体机、非完整视觉质量验收', 'modelSha256':args.sha256, 'runtime':ort.__version__, 'samples':records, 'technicalPass':len(records), 'visualPass':0}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'technicalPass':len(records), 'visualPass':0, 'report':str(out/'report.json')}, ensure_ascii=False))

if __name__ == '__main__':
    main()
