"""RC-10研究后端：固定服装解析；只返回类别图，不生成五官。"""
import base64
import hashlib
import io
import json
import logging
import time
import uuid
from pathlib import Path

MODEL_SHA = 'a93a8dac171b5c1fcc53632a8bfc180bfd9759ea69a3e207451bb07f76add54f'
MODEL_PATH = Path(__file__).parent / 'model.onnx'
_session = None


def _runtime():
    global _session
    if _session is None:
        if not MODEL_PATH.is_file():
            raise RuntimeError('MODEL_MISSING')
        with MODEL_PATH.open('rb') as stream:
            digest = hashlib.sha256()
            for part in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(part)
        if digest.hexdigest() != MODEL_SHA:
            raise RuntimeError('MODEL_INTEGRITY')
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        _session = ort.InferenceSession(str(MODEL_PATH), options, providers=['CPUExecutionProvider'])
    return _session


def main(event, context=None):
    trace = 'suitparse-' + uuid.uuid4().hex
    def fail(code, message):
        logging.warning(json.dumps({'code': code, 'traceId': trace}))
        return {'ok': False, 'code': code, 'message': message, 'traceId': trace}
    if not isinstance(event, dict):
        return fail('SUIT_INPUT_INVALID', '换装输入无效')
    if event.get('consent') != 'faceCloudEnhance' or event.get('suitConsent') != 'suitSwap':
        return fail('CONSENT_REQUIRED', '请分别同意上云处理和换装')
    if event.get('purpose') != 'suit_clothing_parse' or event.get('retain') is not False or event.get('train') is not False or event.get('region') != 'CN':
        return fail('SUIT_POLICY_INVALID', '换装处理参数无效')
    width, height = event.get('width'), event.get('height')
    image = event.get('image')
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 2048 or
            not 1 <= height <= 2048 or width * height > 1600000 or
            not isinstance(image, str) or not 0 < len(image) <= 4 * 1024 * 1024):
        return fail('SUIT_INPUT_INVALID', '图片尺寸或数据大小不支持')
    try:
        from PIL import Image
        data = base64.b64decode(image, validate=True)
        with Image.open(io.BytesIO(data)) as source:
            if source.size != (width, height) or source.format not in ('PNG', 'JPEG'):
                return fail('SUIT_INPUT_INVALID', '图片信息不匹配')
            rgb = source.convert('RGB').resize((512, 512), Image.Resampling.BILINEAR)
    except Exception:
        return fail('SUIT_DECODE_FAILED', '图片读取失败')
    try:
        import numpy as np
        started = time.perf_counter()
        runtime = _runtime()
        pixels = np.asarray(rgb, dtype=np.float32) / 255
        pixels = (pixels - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
        logits = runtime.run(None, {runtime.get_inputs()[0].name: pixels.transpose(2, 0, 1)[None].copy()})[0]
        if logits.shape != (1, 18, 128, 128) or not np.isfinite(logits).all():
            return fail('SUIT_OUTPUT_INVALID', '服装识别结果无效')
        # PIL逐类别浮点双线性恢复，先恢复logits再argmax，避免离散标签插值。
        # 流式argmax只保留一个最大值平面，避免18个全尺寸浮点平面同时驻留。
        # 严格大于保留首个同分类别，与numpy.argmax一致。
        best = np.full((height, width), -np.inf, dtype=np.float32)
        labels = np.zeros((height, width), dtype=np.uint8)
        for category, channel in enumerate(logits[0]):
            resized = np.asarray(Image.fromarray(channel).resize((width, height), Image.Resampling.BILINEAR))
            selected = resized > best
            best[selected] = resized[selected]
            labels[selected] = category
        return {'ok': True, 'width': width, 'height': height, 'classesB64': base64.b64encode(labels.tobytes()).decode('ascii'),
                'provider': 'segformer-b2-clothes-onnx-cpu', 'modelSha256': MODEL_SHA,
                'latencyMs': round((time.perf_counter() - started) * 1000), 'traceId': trace}
    except Exception:
        return fail('SUIT_PARSER_UNAVAILABLE', '服装识别服务暂不可用')
