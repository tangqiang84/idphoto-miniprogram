import Taro from '@tarojs/taro';
import { loadSuitParsingModel } from './suitAssets';
import { createWechatRuntime } from './wechatInference';
import { prepareClothing, decodeClothingLayers } from '../core/suitClothing';
const model = require('../core/suitParsingModel.json');

export async function parseSuitClothing(rgba: Uint8ClampedArray, width: number, height: number, authorization: {check(): void}) {
  const traceId = 'suit-clothing-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
  let session: any;
  try {
    authorization.check();
    const runtime = createWechatRuntime(Taro, {inputName: model.inputName, outputName: model.outputName,
      inputShape: model.inputShape, outputShape: model.outputShape, timeoutMs: 15000});
    if (!runtime) throw {code: 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE'};
    const api: any = Taro;
    if (typeof api.getInferenceEnvInfo !== 'function') throw {code: 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE'};
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer);
        if (ok) resolve(); else reject({code: 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE'}); };
      const timer = setTimeout(() => finish(false), 3000);
      try { api.getInferenceEnvInfo({success: (r: any) => finish(typeof r?.ver === 'string' && r.ver.trim().length > 0), fail: () => finish(false)}); }
      catch { finish(false); }
    });
    authorization.check();
    const file = await loadSuitParsingModel(authorization);
    authorization.check();
    session = await runtime.InferenceSession.create(file);
    authorization.check();
    const input = prepareClothing(rgba, width, height);
    const result = await session.run({[model.inputName]: new runtime.Tensor('float32', input, model.inputShape)});
    authorization.check();
    return {...decodeClothingLayers(result[model.outputName], width, height, rgba),
      evidence: {provider: 'wechat-native-selfie-multiclass', sha256: model.sha256, revision: model.revision, traceId}};
  } catch (error) {
    authorization.check();
    if ((error as any)?.code === 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE') {
      console.warn('[suit-clothing]', {code: 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE', traceId});
      throw {code: 'SUIT_CLOTHING_RUNTIME_UNAVAILABLE', message: '当前环境不支持本地换装，请使用支持该能力的微信环境', traceId};
    }
    console.warn('[suit-clothing]', {code: 'SUIT_CLOTHING_UNAVAILABLE', traceId});
    throw {code: 'SUIT_CLOTHING_UNAVAILABLE', message: '无法可靠识别原衣服，已停止换装；请更换照片或稍后重试', traceId};
  } finally {
    try { session?.release(); } catch { console.warn('[suit-clothing]', {code: 'SUIT_CLOTHING_RELEASE_FAILED', traceId}); }
  }
}
