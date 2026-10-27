# -*- coding: utf-8 -*-
"""posekey 云函数：姿态关键点识别（P1 / 台账 #72）

【定位】L1 信号源。为 T3 换装的 suitFitV2 几何引擎提供**实测**的双肩点，
取代 v1 链路里「行宽突变 / bbox 投影 / 0.3 系数」这类猜测信号（四轮失败的结构性根因）。

【合规】
  · 识别类（姿态关键点），**非生成式**：不产生新的人脸/人体图像，只输出 17 个坐标点
    → 个人主体下保持「识别信号 + 非生成式模板合成」形态（方案 2.1）；
  · 只接收**人像区域**（F1 后上传的就是规格裁剪窗，人充满画面），不传原图；
  · retain=false / train=false / region=CN（与 matting 云函数同口径，数据不出境）。

【契约】
  入参: { image(base64), width, height, region, purpose, retain, train }
  出参: 成功 { keypoints:[{name,x,y,score}], model, latencyMs }   坐标归一化 0~1（相对上传区域）
        失败 { error: 'not_deployed'|'model_missing'|'decode_failed'|'no_person'|'infer_failed' }

【模型】MoveNet SinglePose Lightning int8（Apache-2.0，模型卡与 tfjs-models LICENSE 双确认）。
  放置路径：./model/movenet_singlepose_lightning_int8_4.tflite（部署时随代码上传）
  获取方式：python3 fetch_model.py（见同目录 README.md；Kaggle 源需账号，本脚本给出多源尝试）
  模型未放置 → 云函数正常返回 {'error':'model_missing'}（前端按原因码降级 L2，不崩）。
"""

import base64
import io
import os
import time

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model',
                          'movenet_singlepose_lightning_int8_4.tflite')
MODEL_NAME = 'movenet-lightning-int8'
INPUT_SIZE = 192  # MoveNet Lightning 输入边长

# MoveNet SinglePose 输出的 17 个关键点（COCO 顺序）
KEYPOINT_NAMES = [
    'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
    'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
]


def _decode(image_b64):
    """base64 → RGB 图像（依赖 Pillow；缺失即视为未部署，返回明确错误码）"""
    try:
        from PIL import Image  # noqa: WPS433（延迟导入：缺失时不阻断云函数启动）
    except Exception:
        return None, 'not_deployed'
    try:
        raw = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(raw)).convert('RGB')
        return img, None
    except Exception:
        return None, 'decode_failed'


def _preprocess(img):
    """等比 letterbox 到 192×192（保持人体比例，避免拉伸导致肩点漂移）"""
    try:
        from PIL import Image  # noqa: WPS433
    except Exception:
        return None
    w, h = img.size
    scale = min(INPUT_SIZE / float(w), INPUT_SIZE / float(h))
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = img.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new('RGB', (INPUT_SIZE, INPUT_SIZE), (0, 0, 0))
    canvas.paste(resized, ((INPUT_SIZE - nw) // 2, (INPUT_SIZE - nh) // 2))
    return canvas


def _load_interpreter():
    """加载 tflite 解释器；模型缺失/运行时缺失都返回 None（前端按原因码降级）"""
    if not os.path.exists(MODEL_PATH):
        return None, 'model_missing'
    try:
        # tflite-runtime 优先（包体小）；开发环境可用 tensorflow.lite 兜底
        try:
            from tflite_runtime.interpreter import Interpreter  # type: ignore
        except Exception:
            from tensorflow.lite import Interpreter  # type: ignore
        it = Interpreter(model_path=MODEL_PATH)
        it.allocate_tensors()
        return it, None
    except Exception:
        return None, 'not_deployed'


def _infer(interpreter, img):
    """跑推理 → 17 个归一化关键点（相对输入 192×192，与上传区域同比例）"""
    import numpy as np  # noqa: WPS433

    inp = interpreter.get_input_details()[0]
    out = interpreter.get_output_details()[0]
    arr = np.asarray(img, dtype=np.uint8)
    if inp['dtype'] == np.float32:
        arr = (arr.astype(np.float32) - 127.5) / 127.5
    arr = np.expand_dims(arr, axis=0)
    interpreter.set_tensor(inp['index'], arr)
    interpreter.invoke()
    kps = interpreter.get_tensor(out['index'])  # shape: 1×1×17×3 (y, x, score)
    kps = np.squeeze(kps)  # 17×3
    points = []
    for i in range(min(len(KEYPOINT_NAMES), kps.shape[0])):
        y, x, score = kps[i][0], kps[i][1], kps[i][2]
        points.append({
            'name': KEYPOINT_NAMES[i],
            'x': float(x),
            'y': float(y),
            'score': float(score),
        })
    return points


def run(event, decode=_decode, preprocess=_preprocess, load=_load_interpreter, infer=_infer):
    """可注入依赖的核心流程（便于本地做契约自测，selftest.py 直接调这里）"""
    t0 = time.time()
    image_b64 = (event or {}).get('image') or ''
    if not image_b64:
        return {'error': 'decode_failed', 'message': 'missing image', 'model': MODEL_NAME}
    img, err = decode(image_b64)
    if err:
        return {'error': err, 'model': MODEL_NAME}
    prepared = preprocess(img)
    if prepared is None:
        return {'error': 'not_deployed', 'model': MODEL_NAME}
    interpreter, err = load()
    if err:
        return {'error': err, 'model': MODEL_NAME}
    try:
        points = infer(interpreter, prepared)
    except Exception:
        return {'error': 'infer_failed', 'model': MODEL_NAME}
    if not points:
        return {'error': 'no_person', 'model': MODEL_NAME}
    return {
        'keypoints': points,
        'model': MODEL_NAME,
        'latencyMs': int((time.time() - t0) * 1000),
    }


def main(event, context):
    """CloudBase 云函数入口（Python 运行时）"""
    try:
        return run(event or {})
    except Exception as exc:  # 兜底：任何异常都以契约内的错误码返回，前端据此降级
        return {'error': 'infer_failed', 'message': str(exc)[:200], 'model': MODEL_NAME}
