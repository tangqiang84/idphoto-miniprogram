# -*- coding: utf-8 -*-
"""posekey 契约自测（不依赖 tflite/Pillow/numpy，注入假依赖即可跑）

用法:
    python3 cloudfunctions/posekey/selftest.py
覆盖:
    1. 空 image → decode_failed（不静默造点）
    2. 解码失败 → decode_failed
    3. 模型未放置 → model_missing（前端据此降级 L2，不崩）
    4. 正常路径 → keypoints 17 点、name 为 COCO 名、坐标归一化、带 latencyMs
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import KEYPOINT_NAMES, run  # noqa: E402


class FakeImg(object):
    size = (320, 480)


def ok_decode(_b64):
    return FakeImg(), None


def fail_decode(_b64):
    return None, 'decode_failed'


def fake_preprocess(img):
    return img


def ok_load():
    return object(), None


def missing_load():
    return None, 'model_missing'


def fake_infer(_it, _img):
    return [{'name': n, 'x': 0.5, 'y': i / 17.0, 'score': 0.9} for i, n in enumerate(KEYPOINT_NAMES)]


def empty_infer(_it, _img):
    return []


def boom_infer(_it, _img):
    raise RuntimeError('boom')


def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + ((' -> ' + str(extra)) if extra else ''))
    return 1 if cond else 0


def main():
    passed = 0
    total = 4

    r = run({}, decode=ok_decode)
    passed += check('空 image → decode_failed', r.get('error') == 'decode_failed', r)

    r = run({'image': 'zzz'}, decode=fail_decode)
    passed += check('解码失败 → decode_failed', r.get('error') == 'decode_failed', r)

    r = run({'image': 'AAA'}, decode=ok_decode, preprocess=fake_preprocess, load=missing_load)
    passed += check('模型未放置 → model_missing', r.get('error') == 'model_missing', r)

    r = run({'image': 'AAA'}, decode=ok_decode, preprocess=fake_preprocess, load=ok_load, infer=fake_infer)
    good = (
        'keypoints' in r and len(r['keypoints']) == 17
        and r['keypoints'][5]['name'] == 'left_shoulder'
        and r['keypoints'][6]['name'] == 'right_shoulder'
        and 0.0 <= r['keypoints'][0]['x'] <= 1.0
        and isinstance(r.get('latencyMs'), int)
        and r.get('model') == 'movenet-lightning-int8'
    )
    passed += check('正常路径 → 17 点 + COCO 命名 + 归一化坐标 + latencyMs', good, r.get('keypoints')[:2] if 'keypoints' in r else r)

    # 附加：推理异常 → infer_failed（不把异常抛给前端）
    r = run({'image': 'AAA'}, decode=ok_decode, preprocess=fake_preprocess, load=ok_load, infer=boom_infer)
    passed += check('推理异常 → infer_failed', r.get('error') == 'infer_failed', r)

    print('\n%d/%d passed' % (passed, total + 1))
    return 0 if passed == total + 1 else 1


if __name__ == '__main__':
    sys.exit(main())
