"""换装专用人脸关键点；仅在显式上云和换装授权后运行。"""
import base64
import hashlib
import io
import json
import logging
import math
import time
import uuid
from pathlib import Path

MODEL_SHA = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
MODEL_PATH = Path(__file__).parent / 'face_landmarker.task'
_model = None


def _runtime():
    global _model
    import mediapipe as mp
    if _model is None:
        if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() != MODEL_SHA:
            raise RuntimeError('MODEL_INTEGRITY')
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH), delegate=mp.tasks.BaseOptions.Delegate.CPU),
            running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=2,
            output_face_blendshapes=False, output_facial_transformation_matrixes=False)
        _model = mp.tasks.vision.FaceLandmarker.create_from_options(options)
    return mp, _model


def main(event, context=None):
    trace = 'facepoints-' + uuid.uuid4().hex
    def fail(code, message):
        logging.warning(json.dumps({'code': code, 'traceId': trace}))
        return {'ok': False, 'code': code, 'message': message, 'traceId': trace}
    if not isinstance(event, dict):
        return fail('FACE_INPUT_INVALID', '人脸检测输入无效')
    if event.get('consent') != 'faceCloudEnhance' or event.get('suitConsent') != 'suitSwap':
        return fail('CONSENT_REQUIRED', '请分别同意上云处理和换装')
    if event.get('purpose') != 'suit_face_landmarks' or event.get('region') != 'CN' or event.get('retain') is not False or event.get('train') is not False:
        return fail('FACE_POLICY_INVALID', '人脸检测参数无效')
    w, h, encoded = event.get('width'), event.get('height'), event.get('image')
    if type(w) is not int or type(h) is not int or not 1 <= w <= 2048 or not 1 <= h <= 2048 or w*h > 1600000 or not isinstance(encoded, str) or not 0 < len(encoded) <= 4*1024*1024:
        return fail('FACE_INPUT_INVALID', '图片尺寸或数据大小不支持')
    try:
        from PIL import Image
        import numpy as np
        with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as source:
            if source.size != (w,h) or source.format not in ('JPEG','PNG'):
                return fail('FACE_INPUT_INVALID', '图片信息不匹配')
            pixels = np.asarray(source.convert('RGB'))
    except Exception:
        return fail('FACE_DECODE_FAILED', '图片读取失败')
    try:
        started = time.perf_counter()
        mp, model = _runtime()
        result = model.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(pixels)))
        count = len(result.face_landmarks)
        if count != 1:
            return fail('FACE_NOT_SINGLE', '请使用清晰的单人正面照片')
        points = [{'x': p.x*w, 'y': p.y*h} for p in result.face_landmarks[0]]
        if len(points) != 478 or any(not math.isfinite(p['x']) or not math.isfinite(p['y']) or not 0 <= p['x'] < w or not 0 <= p['y'] < h for p in points):
            return fail('FACE_OUTPUT_INVALID', '人脸关键点不可靠，请更换照片')
        xs, ys = [p['x'] for p in points], [p['y'] for p in points]
        return {'ok': True, 'faceCount': count, 'points': points,
                'rect': {'x': min(xs), 'y': min(ys), 'width': max(xs)-min(xs), 'height': max(ys)-min(ys)},
                'rectSource': 'landmark-envelope', 'confidence': None, 'width': w, 'height': h,
                'provider': 'mediapipe-face-landmarker-cpu', 'modelSha256': MODEL_SHA,
                'latencyMs': round((time.perf_counter()-started)*1000), 'traceId': trace}
    except Exception:
        return fail('FACE_SERVICE_UNAVAILABLE', '人脸检测暂不可用，请稍后重试')
