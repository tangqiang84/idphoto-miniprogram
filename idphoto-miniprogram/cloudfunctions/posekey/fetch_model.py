# -*- coding: utf-8 -*-
"""下载 MoveNet SinglePose Lightning int8 模型到 model/ 目录。

【License】MoveNet 模型卡与 tfjs-models 仓库均为 Apache-2.0（项目 #3/#40 纪律：查模型卡，不查 GitHub 默认声明）。
【为什么多源】Google 把 TF Hub 模型迁到 Kaggle 后，原 GCS 直链已陆续 403；
  本脚本按顺序尝试多个源，任一成功即校验 tflite 文件头（TFL3）后落盘。

用法:
    python3 cloudfunctions/posekey/fetch_model.py
    KAGGLE_USERNAME=xxx KAGGLE_KEY=yyy python3 cloudfunctions/posekey/fetch_model.py   # 需要鉴权的源
"""
import os
import sys
import urllib.request

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model')
OUT_PATH = os.path.join(OUT_DIR, 'movenet_singlepose_lightning_int8_4.tflite')

CANDIDATES = [
    # Kaggle 模型页直链（Google 官方发布；多数情况下需要 Kaggle 账号鉴权）
    'https://www.kaggle.com/api/v1/models/google/movenet/TfLite/singlepose-lightning/4/download',
    # 旧 TF Hub GCS 桶（部分区域仍可用）
    'https://storage.googleapis.com/tfhub-lite-models/google/lite-model/movenet/singlepose/lightning/int8/4/default/1.tflite',
    # Hugging Face 社区镜像（若上述不可用可手动从此下载后放到 model/）
    'https://huggingface.co/onnx-community/movenet-singlepose-lightning/resolve/main/movenet_singlepose_lightning_int8_4.tflite',
]


def is_tflite(data):
    # tflite 文件头含标识符 "TFL3"（偏移 4 处）
    return len(data) > 8 and (data[4:8] == b'TFL3' or b'TFL3' in data[:64])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for url in CANDIDATES:
        try:
            print('尝试下载: %s' % url)
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            if not is_tflite(data):
                print('  └ 不是 tflite 文件（可能被重定向到 HTML 页面），换下一个源')
                continue
            with open(OUT_PATH, 'wb') as f:
                f.write(data)
            print('OK 已保存: %s (%d bytes)' % (OUT_PATH, len(data)))
            return 0
        except Exception as exc:
            print('  └ 失败: %s' % str(exc)[:160])
    print('\n全部源都失败。请手动下载 MoveNet SinglePose Lightning int8（Apache-2.0）'
          ' 并放到: %s' % OUT_PATH)
    print('未放置模型不影响其他功能：云函数会返回 {"error":"model_missing"}，'
          '前端按原因码降级到 L2（faceDetect）+ 物理标尺通道。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
