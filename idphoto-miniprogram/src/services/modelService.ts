// 端侧模型默认关闭；权重、许可引用、运行时版本未固定时不下载、不宣称模型可用。
import Taro from '@tarojs/taro';
import { getModelSpec, resolveWeightFileName, verifyWeight, shouldRetryDownload } from '../core/mattingModel';
import { sha256 } from '../core/sha256';
import { withTimeout } from '../core/asyncUtils';

export interface EdgeModelConfig {
  enabled: boolean;
  modelId: string;
  weightUrl: string;
  sha256?: string;
  artifactRevision?: string;
  licenseEvidence?: string;
  runtimeRevision?: string;
  maxFail?: number;
  cooldownMs?: number;
  timeoutMs?: number;
}
export const EDGE_MODEL_CONFIG: EdgeModelConfig = {
  enabled: false, modelId: 'modnet-q8', weightUrl: '', sha256: '',
  artifactRevision: '', licenseEvidence: '', runtimeRevision: '',
  maxFail: 3, cooldownMs: 30 * 60 * 1000, timeoutMs: 15000,
};
// 覆盖配置仅用于资源就绪后的启动接入或隔离测试，不会自动点亮默认部署。
export interface OrtRuntime {
  Tensor?: new (type: string, data: Float32Array, dims: number[]) => any;
  InferenceSession: { create(path: string, opts?: any): Promise<any> };
  [key: string]: any;
}
let _ort: OrtRuntime | null = null;
let generation = 0;
const state = { failCount: 0, lastFailAt: 0, lastReason: '', session: null as any, sessionSpecId: null as string | null };
function reset() { generation++; state.session = null; state.sessionSpecId = null; state.failCount = 0; state.lastFailAt = 0; state.lastReason = ''; }
export function configureEdgeModel(patch: Partial<EdgeModelConfig>) { Object.assign(EDGE_MODEL_CONFIG, patch); reset(); }
export function setOrtRuntime(ort: OrtRuntime | null) { _ort = ort; reset(); }
export function getOrtRuntime() { return _ort; }
export function __resetModelState() { reset(); }
export function getModelStatus() {
  return { ...state, session: undefined, hasSession: !!state.session, hasOrt: !!_ort,
    config: { enabled: EDGE_MODEL_CONFIG.enabled, modelId: EDGE_MODEL_CONFIG.modelId,
      weightConfigured: !!EDGE_MODEL_CONFIG.weightUrl, sha256Pinned: /^[a-f\d]{64}$/i.test(EDGE_MODEL_CONFIG.sha256 || ''),
      artifactRevision: EDGE_MODEL_CONFIG.artifactRevision || null, runtimeRevision: EDGE_MODEL_CONFIG.runtimeRevision || null } };
}
const fallback = (reason: string) => ({ session: null, spec: null, backend: 'classical', reason, reasonCode: reason });

export async function getEdgeSession(options: { check?: () => void } = {}): Promise<any> {
  const cfg = { ...EDGE_MODEL_CONFIG }, ort = _ort, version = generation;
  const timeout = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 15000;
  const check = () => { options.check?.(); if (version !== generation) throw { code: 'MODEL_STALE' }; };
  check();
  if (!cfg.enabled) return fallback('MODEL_DISABLED');
  if (!ort?.InferenceSession || typeof ort.Tensor !== 'function') return fallback('MODEL_RUNTIME_MISSING');
  const rawSpec = getModelSpec(cfg.modelId);
  if (!rawSpec || rawSpec.edgeOnly || !rawSpec.commercialOk) return fallback('MODEL_SPEC_UNAVAILABLE');
  if (!/^[a-f\d]{64}$/i.test(cfg.sha256 || '') || !cfg.artifactRevision || !cfg.licenseEvidence || !cfg.runtimeRevision) return fallback('MODEL_ARTIFACT_UNPINNED');
  if (!/^https:\/\//.test(cfg.weightUrl)) return fallback('MODEL_URL_UNAVAILABLE');
  const spec = { ...rawSpec, sha256: cfg.sha256 };
  if (state.session && state.sessionSpecId === spec.id) return { session: state.session, spec, backend: 'onnx:' + spec.id, reason: '', reasonCode: '', modelRevision: cfg.artifactRevision };
  let fs: any;
  try { fs = Taro.getFileSystemManager(); } catch { return fallback('MODEL_STORAGE_UNAVAILABLE'); }
  const root = (Taro.env as any)?.USER_DATA_PATH;
  if (!root || !fs) return fallback('MODEL_STORAGE_UNAVAILABLE');
  async function inspect(path: string) {
    const info: any = await withTimeout(new Promise((resolve, reject) => fs.getFileInfo({ filePath: path, success: resolve, fail: reject })), timeout, 'MODEL_FILE_TIMEOUT');
    check();
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > 64 * 1024 * 1024) throw { code: 'MODEL_WEIGHT_INVALID' };
    const file: any = await withTimeout(new Promise((resolve, reject) => fs.readFile({ filePath: path, success: resolve, fail: reject })), timeout, 'MODEL_FILE_TIMEOUT');
    check();
    const bytes = new Uint8Array(file.data);
    if (bytes.length !== info.size) throw { code: 'MODEL_WEIGHT_INVALID' };
    return { exists: true, size: info.size, sha256: sha256(bytes) };
  }
  try {
    let path = root + '/' + resolveWeightFileName(spec);
    let cached: any = null;
    try { cached = await inspect(path); } catch { check(); }
    if (!cached || !verifyWeight(cached, spec).ok) {
      const retry = shouldRetryDownload({ failCount: state.failCount, lastFailAt: state.lastFailAt, now: Date.now(), maxFail: cfg.maxFail, cooldownMs: cfg.cooldownMs });
      if (!retry.retry) return fallback('MODEL_RETRY_COOLDOWN');
      check();
      // 由平台分配唯一临时路径；不覆盖/删除既有缓存，包括校验失败文件。
      const downloaded: any = await withTimeout(Taro.downloadFile({ url: cfg.weightUrl }), timeout, 'MODEL_DOWNLOAD_TIMEOUT');
      check();
      if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw { code: 'MODEL_DOWNLOAD_FAILED' };
      path = downloaded.tempFilePath;
      if (!verifyWeight(await inspect(path), spec).ok) throw { code: 'MODEL_WEIGHT_INVALID' };
    }
    check();
    const raw: any = await withTimeout(ort.InferenceSession.create(path, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential' }), timeout, 'MODEL_SESSION_TIMEOUT');
    try { check(); } catch (error) { if (typeof raw.release === 'function') Promise.resolve(raw.release()).catch(() => {}); throw error; }
    if (typeof raw.run !== 'function') throw { code: 'MODEL_RUNTIME_INVALID' };
    const session = { Tensor: ort.Tensor, inputNames: raw.inputNames, outputNames: raw.outputNames, run: raw.run.bind(raw) };
    state.session = session; state.sessionSpecId = spec.id; state.failCount = 0; state.lastReason = '';
    return { session, spec, backend: 'onnx:' + spec.id, reason: '', reasonCode: '', modelRevision: cfg.artifactRevision };
  } catch (error: any) {
    check();
    const allowed = ['MODEL_WEIGHT_INVALID','MODEL_DOWNLOAD_FAILED','MODEL_RUNTIME_INVALID'];
    const code = allowed.includes(error?.code) ? error.code : /TIMEOUT/.test(String(error?.message || '')) ? 'MODEL_TIMEOUT' : 'MODEL_UNAVAILABLE';
    state.failCount++; state.lastFailAt = Date.now(); state.lastReason = code;
    return fallback(code);
  }
}
export async function prepareModelForSegment(options: { check?: () => void } = {}) {
  const start = Date.now();
  const result = await getEdgeSession(options);
  return { ...result, initializationMs: Date.now() - start };
}
