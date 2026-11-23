#!/usr/bin/env python3
"""新建T1本地实际UI验证工程，禁用云端请求；不覆盖生产dist或已有报告。"""
import argparse
import datetime
import hashlib
import json
import subprocess
import sys
import uuid
from pathlib import Path
from verify_runner import snapshot, write_json

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', default=str(ROOT))
    args = parser.parse_args()
    source = Path(args.source).resolve()
    out = ROOT / 'docs/验证记录/t1-local-builds' / ('run-' + uuid.uuid4().hex[:12])
    out.mkdir(parents=True)
    inputs = snapshot(source, out / 'workspace')
    write_json(out / 'production-inputs.json', inputs)
    app = out / 'workspace/idphoto-miniprogram'
    # 仅隔离工程替换网络适配器：真实微信UI/本地图像算法，绝不上传样本人像。
    adapter = app / 'src/services/cloudFnAdapter.ts'
    adapter_source = adapter.read_text(encoding='utf-8')
    guard = 'const pending: unknown = Taro.cloud.callFunction'
    if adapter_source.count(guard) != 1:
        raise ValueError('CLOUD_GUARD_ANCHOR_CHANGED')
    adapter.write_text(adapter_source.replace(guard,
        "throw new Error('RC05_NETWORK_BLOCKED');\n          " + guard), encoding='utf-8')
    pose = app / 'src/services/poseService.ts'
    pose_source = pose.read_text(encoding='utf-8')
    guard = 'const res: any = await makeCloudFnAdapter'
    if pose_source.count(guard) != 1:
        raise ValueError('POSE_GUARD_ANCHOR_CHANGED')
    pose.write_text(pose_source.replace(guard,
        "throw new Error('RC05_NETWORK_BLOCKED');\n    " + guard), encoding='utf-8')
    write_json(app / 'rc05-local-only.json', {'mode': 'network-blocked/local-algorithm/real-wechat-ui',
        'source_root': str(source), 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'changed_adapters': ['src/services/cloudFnAdapter.ts', 'src/services/poseService.ts']})
    with (out / 'build.log').open('x') as stream:
        result = subprocess.run(['npm', 'run', 'build:weapp'], cwd=str(app), stdout=stream, stderr=subprocess.STDOUT)
    files = {str(p.relative_to(app / 'dist')): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted((app / 'dist').rglob('*')) if p.is_file()} if (app / 'dist').exists() else {}
    write_json(out / 'build-files.json', files)
    write_json(out / 'report.json', {'status': 'PASS' if result.returncode == 0 and 'app.json' in files else 'FAIL',
        'app': str(app), 'exit_code': result.returncode, 'scope': '本地算法/禁云验证构建，非生产云能力验收',
        'build_id': hashlib.sha256((out / 'build-files.json').read_bytes()).hexdigest()})
    print(json.dumps({'app': str(app), 'report': str(out / 'report.json'), 'exit_code': result.returncode}, ensure_ascii=False))
    return result.returncode

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'code': 'T1_LOCAL_BUILD_ERROR', 'message': '隔离验证工程准备失败，已生成文件保留', 'traceId': uuid.uuid4().hex}, ensure_ascii=False))
        sys.exit(2)
