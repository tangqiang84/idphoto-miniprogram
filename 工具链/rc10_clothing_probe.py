#!/usr/bin/env python3
"""本地真实衣物解析，调用产品预处理；不发送照片，不代表微信推理已验收。"""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    root = Path(__file__).resolve().parent.parent
    spec = json.loads((root / 'idphoto-miniprogram/src/core/suitParsingModel.json').read_text())
    model = Path(args.model).resolve()
    assert hashlib.sha256(model.read_bytes()).hexdigest() == spec['sha256']
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = Path(args.image).resolve()
    image = Image.open(source).convert('RGBA')
    w, h = image.size
    (out / 'source.rgba').write_bytes(image.tobytes())
    script = "const fs=require('fs'),m=require('./idphoto-miniprogram/src/core/suitClothing');const b=fs.readFileSync(process.argv[1]);const t=m.prepareClothing(new Uint8ClampedArray(b.buffer,b.byteOffset,b.length),Number(process.argv[3]),Number(process.argv[4]));fs.writeFileSync(process.argv[2],Buffer.from(t.buffer,t.byteOffset,t.byteLength));"
    subprocess.run(['node', '-e', script, str(out / 'source.rgba'), str(out / 'input.float32'), str(w), str(h)], cwd=str(root), check=True)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
    x = np.fromfile(out / 'input.float32', dtype=np.float32).reshape(spec['inputShape'])
    start = time.perf_counter()
    y = session.run([spec['outputName']], {spec['inputName']: x})[0]
    latency = (time.perf_counter() - start) * 1000
    assert list(y.shape) == spec['outputShape'] and np.isfinite(y).all()
    y.astype('float32').tofile(out / 'logits.float32')
    np.save(out / 'logits.npy', y)
    mask = Image.fromarray((y[0].argmax(-1) == 4).astype('uint8') * 255).resize((w,h), Image.Resampling.NEAREST)
    mask.save(out / 'clothes.png')
    report = {'inputSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'modelSha256': spec['sha256'],
              'inputShape': spec['inputShape'], 'outputShape': list(y.shape), 'provider': 'onnxruntime-cpu',
              'preprocessing': 'actual-core-prepareClothing', 'latencyMs': round(latency,2),
              'runtime': ort.__version__, 'photoUploads': 0, 'wechatNativeVerified': False}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
