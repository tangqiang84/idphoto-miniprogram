import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('baidu_pose', ROOT / 'idphoto-miniprogram/cloudfunctions/posekey/baidu_pose.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PoseTests(unittest.TestCase):
    def run_case(self, result, change=None):
        event = dict(consent='faceCloudEnhance', region='CN', purpose='pose_keypoints', retain=False, train=False, width=100, height=140, image='fixture')
        event.update(change or {})
        calls = []
        def request(path, fields):
            calls.append(path)
            return {'access_token': 'fixture'} if len(calls) == 1 else result
        return module.run_baidu(event, {'BAIDU_API_KEY': 'fixture', 'BAIDU_SECRET_KEY': 'fixture'}, request), calls

    def result(self):
        return {'person_num': 1, 'person_info': [{'body_parts': {'left_shoulder': {'x': 20, 'y': 70, 'score': .9}, 'right_shoulder': {'x': 80, 'y': 70, 'score': .8}}}]}

    def test_success(self):
        r, calls = self.run_case(self.result())
        self.assertEqual(r['personCount'], 1)
        self.assertEqual(r['keypoints'][0]['x'], .2)
        self.assertEqual(r['keypoints'][0]['y'], .5)
        self.assertEqual(len(calls), 2)

    def test_consent(self):
        r, calls = self.run_case({}, {'consent': None})
        self.assertEqual(r['error'], 'consent_required')
        self.assertEqual(calls, [])

    def test_multiple(self):
        r, _ = self.run_case({'person_num': 2, 'person_info': [{}, {}]})
        self.assertEqual(r['error'], 'multiple_people')

    def test_invalid_point(self):
        data = self.result()
        data['person_info'][0]['body_parts']['left_shoulder']['score'] = 2
        r, _ = self.run_case(data)
        self.assertEqual(r['error'], 'bad_result')

    def test_error(self):
        r, _ = self.run_case({'error_code': 17, 'error_msg': 'PRIVATE_FIXTURE'})
        self.assertEqual(r['error'], 'infer_failed')
        self.assertNotIn('PRIVATE_FIXTURE', str(r))

if __name__ == '__main__':
    unittest.main()
