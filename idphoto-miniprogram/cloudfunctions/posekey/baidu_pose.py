"""百度人体关键点适配；仅在显式选择provider后调用，不记录图片和凭据。"""
import json
import math
import time
import uuid
import urllib.request
import urllib.parse

HOST = 'https://aip.baidubce.com'


def post(path, fields):
    body = urllib.parse.urlencode(fields).encode('ascii')
    request = urllib.request.Request(HOST + path, data=body,
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read(1024 * 1024))


def run_baidu(event, env, request=post):
    trace = 'pose-' + uuid.uuid4().hex
    start = time.monotonic()

    def fail(code, message):
        print(json.dumps({'traceId': trace, 'code': code}))
        return {'error': code, 'message': message, 'traceId': trace}

    if not isinstance(event, dict) or event.get('consent') != 'faceCloudEnhance' or event.get('region') != 'CN' or event.get('purpose') != 'pose_keypoints' or event.get('retain') is not False or event.get('train') is not False:
        return fail('consent_required', '请确认姿态分析上云授权')
    w, h = event.get('width'), event.get('height')
    image = event.get('image')
    if type(w) is not int or type(h) is not int or min(w, h) < 15 or max(w, h) > 4096 or not isinstance(image, str) or not image or len(urllib.parse.urlencode({'image': image}).encode('ascii')) > 4 * 1024 * 1024:
        return fail('bad_request', '姿态分析图片参数无效')
    if not env.get('BAIDU_API_KEY') or not env.get('BAIDU_SECRET_KEY'):
        return fail('not_deployed', '姿态服务尚未配置')
    try:
        token = request('/oauth/2.0/token', {'grant_type': 'client_credentials',
                        'client_id': env['BAIDU_API_KEY'], 'client_secret': env['BAIDU_SECRET_KEY']})
        if not isinstance(token.get('access_token'), str) or not token['access_token']:
            return fail('auth_failed', '姿态服务授权不可用')
        result = request('/rest/2.0/image-classify/v1/body_analysis?access_token=' + urllib.parse.quote(token['access_token'], safe=''), {'image': image})
        if result.get('error_code'):
            return fail('infer_failed', '姿态服务暂不可用')
        count, people = result.get('person_num'), result.get('person_info')
        if type(count) is not int or not isinstance(people, list) or count != len(people):
            return fail('bad_result', '姿态结果不完整')
        if count != 1:
            return fail('multiple_people' if count > 1 else 'no_person', '仅支持单人正面证件照')
        points = []
        for name in ['left_shoulder', 'right_shoulder']:
            point = people[0].get('body_parts', {}).get(name, {})
            x, y, score = point.get('x'), point.get('y'), point.get('score')
            if not all(type(v) in (int, float) and math.isfinite(v) for v in [x, y, score]) or not 0 <= x < w or not 0 <= y < h or not 0 <= score <= 1:
                return fail('bad_result', '双肩定位结果无效')
            points.append({'name': name, 'x': x / w, 'y': y / h, 'score': score})
        return {'keypoints': points, 'personCount': count, 'model': 'baidu-body-analysis',
                'latencyMs': int((time.monotonic() - start) * 1000), 'traceId': trace}
    except Exception:
        return fail('infer_failed', '姿态分析暂不可用，请稍后再试')
