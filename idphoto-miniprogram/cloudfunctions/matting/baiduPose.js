'use strict';
const { randomBytes } = require('crypto');
const { defaultRequest, makeBaiduSegClient } = require('./baiduSeg');
const POSE_URL = 'https://aip.baidubce.com/rest/2.0/image-classify/v1/body_analysis';
async function handlePose(event, opts = {}) {
  const traceId = 'pose-' + randomBytes(8).toString('hex'), started = Date.now();
  const fail = (code, message) => ({ ok: false, error: code, code, message, traceId });
  if (event.consent !== 'faceCloudEnhance' || event.suitConsent !== 'suitSwap') return fail('CONSENT_REQUIRED', '请单独同意上云与换装');
  if (event.region !== 'CN' || event.retain !== false || event.train !== false || event.purpose !== 'pose_keypoints')
    return fail('POSE_CONTRACT_INVALID', '姿态请求用途或数据处理参数无效');
  const { width, height, image } = event;
  if (![width, height].every(v => Number.isInteger(v) && v >= 15 && v <= 4096) ||
      typeof image !== 'string' || image.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4)
    return fail('POSE_INPUT_INVALID', '姿态图片或尺寸无效');
  const body = 'image=' + encodeURIComponent(image);
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) return fail('POSE_IMAGE_TOO_LARGE', '姿态图片过大，请重新裁剪');
  const env = opts.env || process.env;
  if (!env.BAIDU_API_KEY || !env.BAIDU_SECRET_KEY || String(env.BAIDU_ENABLED).toLowerCase() === 'false')
    return fail('POSE_NOT_CONFIGURED', '姿态服务尚未配置');
  try {
    const request = opts.requestImpl || defaultRequest;
    const client = makeBaiduSegClient({ apiKey: env.BAIDU_API_KEY, secretKey: env.BAIDU_SECRET_KEY, requestImpl: request, timeoutMs: 5000 });
    const token = await client.getToken();
    const response = await request(POSE_URL + '?access_token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 5000,
    });
    if (response.status !== 200) throw new Error('HTTP_FAILED');
    const json = JSON.parse(response.text);
    if (json.error_code !== undefined || json.error_msg !== undefined) return fail('POSE_PROVIDER_REJECTED', '姿态服务拒绝请求，请检查服务权限或稍后重试');
    if (json.person_num !== 1 || !Array.isArray(json.person_info) || json.person_info.length !== 1)
      return fail('POSE_PERSON_COUNT', '请使用仅有一人的正面照片');
    const parts = json.person_info[0].body_parts;
    const keypoints = [];
    for (const name of ['left_shoulder', 'right_shoulder']) {
      const p = parts && parts[name];
      if (!p || ![p.x, p.y, p.score].every(Number.isFinite) || p.score < 0.5 || p.score > 1 || p.x <= 0 || p.y <= 0 || p.x >= width - 1 || p.y >= height - 1)
        return fail('POSE_UNRELIABLE_SHOULDERS', '未检测到完整可靠的双肩，请调整照片构图');
      keypoints.push({ name, x: p.x / width, y: p.y / height, score: p.score });
    }
    return { ok: true, keypoints, personCount: 1, model: 'baidu-body-analysis', latencyMs: Date.now() - started, traceId };
  } catch {
    console.warn('[pose]', { traceId, code: 'POSE_SERVICE_FAILED' });
    return fail('POSE_SERVICE_FAILED', '姿态服务暂不可用，请稍后重试');
  }
}
module.exports = { handlePose, POSE_URL };
