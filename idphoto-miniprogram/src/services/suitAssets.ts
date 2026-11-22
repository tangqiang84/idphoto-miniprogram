import Taro from '@tarojs/taro';
import { makeCloudFnAdapter } from './cloudFnAdapter';
import { sha256Async } from '../core/sha256';

export const researchTemplates = [
  { id: 'research-white', name: '白色正装', src: require('../assets/suits/research-white-thumb.png') },
  { id: 'research-navy', name: '深蓝正装', src: require('../assets/suits/research-navy-thumb.png') },
  { id: 'research-black', name: '黑色正装', src: require('../assets/suits/research-black-thumb.png') },
];
const files = new Map<string, string>();
const CHUNK_BYTES = 512 * 1024;
const parsingModel = require('../core/suitParsingModel.json');

export async function loadResearchTemplate(template: any, authorization: { check(): void }): Promise<string> {
  if (!researchTemplates.some(t => t.id === template.id) || !Number.isInteger(template.bytes) || template.bytes <= 0 || template.bytes > 8 * 1024 * 1024)
    throw { code: 'SUIT_ASSET_INVALID', message: '模板信息无效' };
  return loadAsset(template, authorization, 'suit-template', '.png');
}
export async function loadSuitParsingModel(authorization: { check(): void }): Promise<string> {
  return loadAsset(parsingModel, authorization, 'suit-parsing-model', '.onnx');
}
async function loadAsset(template: any, authorization: { check(): void }, action: string, suffix: string): Promise<string> {
  authorization.check();
  const key = template.id + ':' + template.sha256;
  if (files.has(key)) return files.get(key)!;
  const api: any = Taro;
  const adapter = makeCloudFnAdapter({ authorization, resultType: 'raw' });
  const fs = api.getFileSystemManager();
  const fixedPath = api.env.USER_DATA_PATH + '/suit-' + template.sha256 + suffix;
  let existing = false;
  if (typeof fs.accessSync === 'function') { try { fs.accessSync(fixedPath); existing = true; } catch {} }
  if (existing) {
    try {
      const cached = new Uint8Array(fs.readFileSync(fixedPath));
      if (cached.length === template.bytes && await sha256Async(cached, {check: () => authorization.check()}) === template.sha256) {
        authorization.check(); files.set(key, fixedPath); return fixedPath;
      }
    } catch { authorization.check(); }
  }
  const bytes = new Uint8Array(template.bytes), count = Math.ceil(template.bytes / CHUNK_BYTES);
  for (let chunk = 0; chunk < count; chunk++) {
    authorization.check();
    const result: any = await adapter.call({ action, consent: 'suitSwap', templateId: template.id, chunk });
    authorization.check();
    if (!result.ok || result.chunk !== chunk || result.chunks !== count || result.templateId !== template.id || result.bytes !== template.bytes || result.sha256 !== template.sha256 || typeof result.dataB64 !== 'string')
      throw { code: 'SUIT_ASSET_RESPONSE_INVALID', message: '模板加载失败，请稍后重试' };
    const part = new Uint8Array(api.base64ToArrayBuffer(result.dataB64));
    if (part.length !== Math.min(CHUNK_BYTES, bytes.length - chunk * CHUNK_BYTES))
      throw { code: 'SUIT_ASSET_RESPONSE_INVALID', message: '模板数据不完整' };
    bytes.set(part, chunk * CHUNK_BYTES);
  }
  if (await sha256Async(bytes, { check: () => authorization.check() }) !== template.sha256)
    throw { code: 'SUIT_ASSET_INTEGRITY', message: '模板完整性核验失败' };
  authorization.check();
  // 损坏缓存保留；新资源优先使用固定摘要路径，避免每次启动重复占用空间。
  const file = !existing && typeof fs.accessSync === 'function' ? fixedPath
    : api.env.USER_DATA_PATH + '/suit-' + template.sha256 + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + suffix;
  try { fs.writeFileSync(file, bytes.buffer); }
  catch { throw { code: 'SUIT_ASSET_WRITE_FAILED', message: '模板保存失败，请检查可用空间' }; }
  authorization.check(); files.set(key, file);
  return file;
}
