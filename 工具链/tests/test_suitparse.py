"""独立CPU后端边界回归；合成图片不代表真人质量验收。"""
import base64
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('suitparse', ROOT / 'idphoto-miniprogram/cloudfunctions/suitparse/index.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class SuitParseTests(unittest.TestCase):
    def setUp(self):
        stream = io.BytesIO()
        Image.new('RGB', (9, 7), (20, 40, 80)).save(stream, format='PNG')
        self.request = dict(consent='faceCloudEnhance', suitConsent='suitSwap', purpose='suit_clothing_parse',
                            retain=False, train=False, region='CN', width=9, height=7,
                            image=base64.b64encode(stream.getvalue()).decode())

    def test_invalid_requests_never_start_model(self):
        cases = [None, [], {}, *[dict(self.request, **change) for change in [
            {'consent': ''}, {'suitConsent': ''}, {'retain': 0}, {'train': 0}, {'region': 'US'},
            {'purpose': 'other'}, {'width': True}, {'height': 0}, {'width': 2049},
            {'width': 1600, 'height': 1600}, {'image': 'INVALID!'}, {'width': 8},
            {'image': 'A' * (4 * 1024 * 1024 + 1)}]]]
        with patch.object(backend, '_runtime') as runtime:
            for case in cases:
                with self.subTest(case=type(case).__name__):
                    result = backend.main(case)
                    self.assertFalse(result['ok'])
                    self.assertTrue(result['message'])
                    self.assertTrue(result['traceId'])
            runtime.assert_not_called()

    def test_streaming_matches_independent_stack_argmax(self):
        rng = np.random.default_rng(10)
        logits = rng.normal(size=(1, 18, 128, 128)).astype(np.float32)
        logits[0, 1] = logits[0, 0]  # 同分仍取较小类别。
        expected = np.stack([np.asarray(Image.fromarray(channel).resize((9, 7), Image.Resampling.BILINEAR))
                             for channel in logits[0]]).argmax(0).astype(np.uint8)
        with patch.object(backend, '_runtime') as runtime:
            runtime.return_value.run.return_value = [logits]
            result = backend.main(self.request)
        self.assertTrue(result['ok'])
        self.assertEqual(base64.b64decode(result['classesB64']), expected.tobytes())
        self.assertEqual(result['modelSha256'], backend.MODEL_SHA)

    def test_malformed_model_output_rejected(self):
        for logits in [np.zeros((1, 6, 128, 128)), np.full((1, 18, 128, 128), np.nan),
                       np.full((1, 18, 128, 128), np.inf)]:
            with patch.object(backend, '_runtime') as runtime:
                runtime.return_value.run.return_value = [logits]
                self.assertEqual(backend.main(self.request)['code'], 'SUIT_OUTPUT_INVALID')

    def test_exception_and_photo_not_in_logs_or_response(self):
        marker = 'PRIVATE_INTERNAL_EXCEPTION'
        with patch.object(backend, '_runtime', side_effect=RuntimeError(marker)), self.assertLogs(level='WARNING') as logs:
            result = backend.main(self.request)
        output = str(result) + str(logs.output)
        self.assertNotIn(marker, output)
        self.assertNotIn(self.request['image'], output)
        self.assertEqual(result['code'], 'SUIT_PARSER_UNAVAILABLE')
        self.assertIn(result['traceId'], output)

    def test_missing_and_corrupt_weight_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.onnx'
            with patch.object(backend, 'MODEL_PATH', path), patch.object(backend, '_session', None):
                self.assertEqual(backend.main(self.request)['code'], 'SUIT_PARSER_UNAVAILABLE')
                path.write_bytes(b'invalid model')
                self.assertEqual(backend.main(self.request)['code'], 'SUIT_PARSER_UNAVAILABLE')
                self.assertIsNone(backend._session)


if __name__ == '__main__':
    unittest.main()
