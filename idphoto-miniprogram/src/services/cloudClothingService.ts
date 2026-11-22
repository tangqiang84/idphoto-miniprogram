import { resizeSuitMask } from '../core/suitImageSpace';
import Taro from '@tarojs/taro';
import { makeCloudFnAdapter } from './cloudFnAdapter';
import { MODEL_SHA, PROVIDER, decodeSuitClasses } from '../core/suitCloudParsing';

export async function parseCloudSuitClothing(imageB64: string | null, width: number, height: number, authorization: {check(): void}, target = {width, height}) {
  const traceId = 'suit-cloud-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  try {
    authorization.check();
    if (!imageB64 || imageB64.length > 4 * 1024 * 1024 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 1600000) throw {code: 'SUIT_INPUT_INVALID'};
    const result = await makeCloudFnAdapter({name: 'suitparse', authorization, resultType: 'raw'}).call({
      image: imageB64, width, height, consent: 'faceCloudEnhance', suitConsent: 'suitSwap',
      purpose: 'suit_clothing_parse', region: 'CN', retain: false, train: false,
    });
    authorization.check();
    const encoded = result.classesB64;
    if (result.ok !== true || result.width !== width || result.height !== height || result.provider !== PROVIDER || result.modelSha256 !== MODEL_SHA ||
      typeof encoded !== 'string' || encoded.length !== Math.ceil(width * height / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw {code: 'SUIT_CLOTHING_INVALID'};
    const labels = new Uint8Array(Taro.base64ToArrayBuffer(encoded));
    const layers = decodeSuitClasses(labels, width, height);
    authorization.check();
    return {...layers, clothing:resizeSuitMask(layers.clothing,width,height,target), background:resizeSuitMask(layers.background,width,height,target), evidence: {provider: PROVIDER, sha256: MODEL_SHA, traceId, inputWidth:width, inputHeight:height, workWidth:target.width, workHeight:target.height}};
  } catch {
    authorization.check();
    console.warn('[suit-cloud]', {code: 'SUIT_CLOTHING_UNAVAILABLE', traceId});
    throw {code: 'SUIT_CLOTHING_UNAVAILABLE', message: '服装识别暂不可用，已停止换装，请稍后重试', traceId};
  }
}
