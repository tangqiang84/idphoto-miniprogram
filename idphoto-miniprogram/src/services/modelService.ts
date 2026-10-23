// 端侧真模型接入：权重管理 + session 加载 + 优雅降级
//
// 【设计前提 —— 三条项目硬约束】
// 1. **禁止在项目内 npm install 新包**（会重排 node_modules/webpack，可能把 webpack 从 5.89.0
//    升上去而破坏 Taro 3.6.23 的构建）。故 onnxruntime **不做静态 import**，由调用方注入
//    （见 setOrtRuntime）。没注入 → 自动走经典基线，编译与运行都不受影响。
// 2. **小程序包体积**：主包 2MB / 单分包 2MB / 总包 20MB，模型权重（MODNet q8 约 7MB）
//    塞不进包 → 只能运行时下载到 USER_DATA_PATH 并缓存。
// 3. **默认行为必须零回归**：EDGE_MODEL_CONFIG 默认 enabled=false + weightUrl 为空，
//    此时本模块任何导出都不会触发下载，行为与接入前完全一致（经典色键基线）。
//
// 【降级纪律】模型链路任何一步失败，都必须**显式**退回经典基线并把原因返回给调用方，
// 由 UI 决定是否提示。绝不在本模块内部静默吞掉错误 ——
// 否则「模型坏了」会表现为「抠图质量变差」，用户和日志都看不到原因。

import Taro from '@tarojs/taro';
import {
  getModelSpec, resolveWeightFileName, verifyWeight, resolveModelPlan, shouldRetryDownload,
} from '../core/mattingModel';

// ===================== 配置（部署时填写） =====================
export interface EdgeModelConfig {
  enabled: boolean;      // 总开关。默认 false —— 未配置权重时不改变任何现有行为
  modelId: string;       // 对应 core/mattingModel 的 MODEL_SPECS 键
  weightUrl: string;     // 权重下载地址（必须 https，且需在小程序后台 downloadFile 合法域名中配置）
  sha256?: string;       // 可选。填了才做完整性校验（强烈建议填，防权重损坏/被替换）
  maxFail?: number;      // 连续失败几次后停止重试，默认 3
  cooldownMs?: number;   // 失败冷却时长，默认 30 分钟
}

export const EDGE_MODEL_CONFIG: EdgeModelConfig = {
  enabled: false,
  modelId: 'modnet-q8',
  weightUrl: '',
  sha256: '',
  maxFail: 3,
  cooldownMs: 30 * 60 * 1000,
};

// 覆盖配置（供测试或不同环境注入）
export function configureEdgeModel(patch: Partial<EdgeModelConfig>) {
  Object.assign(EDGE_MODEL_CONFIG, patch);
}

// ===================== 推理运行时注入 =====================
// 期望形状：{ InferenceSession: { create(path, opts) -> Promise<session> } }
// 小程序端通常是 onnxruntime-web 的 ort 对象（需自行引入到你的构建中，本项目默认不引入）。
export interface OrtRuntime {
  InferenceSession: { create(path: string, opts?: any): Promise<any> };
  [k: string]: any;
}
let _ort: OrtRuntime | null = null;
export function setOrtRuntime(ort: OrtRuntime | null) {
  _ort = ort;
}
export function getOrtRuntime() {
  return _ort;
}

// ===================== 会话内状态（不持久化，仅本次启动有效） =====================
const _state: {
  failCount: number;
  lastFailAt: number;
  lastReason: string;
  session: any;
  sessionSpecId: string | null;
} = { failCount: 0, lastFailAt: 0, lastReason: '', session: null, sessionSpecId: null };

export function getModelStatus() {
  return {
    failCount: _state.failCount,
    lastFailAt: _state.lastFailAt,
    lastReason: _state.lastReason,
    hasSession: !!_state.session,
    sessionSpecId: _state.sessionSpecId,
    hasOrt: !!_ort,
    config: { ...EDGE_MODEL_CONFIG },
  };
}

// 测试用：重置会话状态
export function __resetModelState() {
  _state.failCount = 0;
  _state.lastFailAt = 0;
  _state.lastReason = '';
  _state.session = null;
  _state.sessionSpecId = null;
}

// ===================== 文件系统工具 =====================
function getFs() {
  const anyTaro: any = Taro;
  if (typeof anyTaro.getFileSystemManager !== 'function') return null;
  return anyTaro.getFileSystemManager();
}

function weightPath(spec: any): string | null {
  const name = resolveWeightFileName(spec);
  if (!name) return null;
  const root = (Taro.env && (Taro.env as any).USER_DATA_PATH) || '';
  return root ? `${root}/${name}` : null;
}

// 读取已缓存权重的元信息（存在性 + 体积 + sha256）
function statCached(spec: any): { exists: boolean; size: number; sha256: string } {
  const p = weightPath(spec);
  const fs = getFs();
  if (!p || !fs) return { exists: false, size: 0, sha256: '' };
  try {
    const info: any = fs.getFileInfo({ filePath: p, digestAlgorithm: 'sha256' });
    return { exists: true, size: info.size || 0, sha256: info.digest || '' };
  } catch (e) {
    // 文件不存在会抛错，属正常路径，不是异常
    return { exists: false, size: 0, sha256: '' };
  }
}

// ===================== 下载权重 =====================
async function downloadWeight(spec: any, url: string): Promise<string> {
  const p = weightPath(spec);
  if (!p) throw new Error('无法确定权重缓存路径');
  const res: any = await Taro.downloadFile({ url, filePath: p });
  const code = res && res.statusCode;
  if (code && code >= 400) throw new Error(`下载失败 HTTP ${code}`);
  // 落盘后立即校验，避免使用损坏的权重
  const stat = statCached(spec);
  const expectSha = EDGE_MODEL_CONFIG.sha256 || spec.sha256;
  const v = verifyWeight({ size: stat.size, sha256: stat.sha256 }, expectSha ? { ...spec, sha256: expectSha } : spec);
  if (!v.ok) {
    // 校验失败必须删掉坏文件，否则下次会命中「缓存存在」而一直用坏权重
    try { getFs()?.unlink({ filePath: p }); } catch (e) { /* 删不掉就算了，下次按体积不符重下 */ }
    throw new Error(`权重校验失败：${v.reason}`);
  }
  return p;
}

// ===================== 会话级 session 获取（带降级） =====================
// 返回 { session, spec, backend, reason }；session 为 null 时 backend='classical' 并给出 reason。
export async function getEdgeSession(): Promise<{
  session: any; spec: any; backend: string; reason: string;
}> {
  const cfg = EDGE_MODEL_CONFIG;
  const spec = getModelSpec(cfg.modelId);
  const plan = resolveModelPlan({
    config: cfg,
    runtime: { hasOrt: !!_ort },
    cached: spec ? statCached(spec) : { exists: false, size: 0, sha256: '' },
    spec,
  });

  if (plan.action === 'classical') {
    return { session: null, spec: null, backend: 'classical', reason: plan.reason };
  }

  // 下载路径：先过失败退避，避免反复白耗流量
  if (plan.action === 'download') {
    const retry = shouldRetryDownload({
      lastFailAt: _state.lastFailAt,
      failCount: _state.failCount,
      now: Date.now(),
      cooldownMs: cfg.cooldownMs,
      maxFail: cfg.maxFail,
    });
    if (!retry.retry) {
      return { session: null, spec: null, backend: 'classical', reason: retry.reason };
    }
  }

  // 复用已建好的 session（同一进程内不重复创建，避免重复占用内存）
  if (_state.session && _state.sessionSpecId === plan.spec.id) {
    return { session: _state.session, spec: plan.spec, backend: `onnx:${plan.spec.id}`, reason: '' };
  }

  try {
    let path = weightPath(plan.spec);
    if (plan.action === 'download') {
      path = await downloadWeight(plan.spec, cfg.weightUrl);
    }
    if (!path) throw new Error('权重路径为空');
    const ort = _ort;
    if (!ort || !ort.InferenceSession) throw new Error('推理运行时未正确注入（缺少 InferenceSession）');
    // 单线程执行：小程序逻辑层没有 Web Worker，多线程 EP 会失败
    const session = await ort.InferenceSession.create(path, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      // 显式关线程 —— 否则 ort 会尝试起 Worker 并在小程序里报错
      executionMode: 'sequential',
    } as any);
    _state.session = session;
    _state.sessionSpecId = plan.spec.id;
    _state.failCount = 0;
    _state.lastReason = '';
    return { session, spec: plan.spec, backend: `onnx:${plan.spec.id}`, reason: '' };
  } catch (e) {
    const reason = String((e && e.message) || e);
    _state.failCount += 1;
    _state.lastFailAt = Date.now();
    _state.lastReason = reason;
    _state.session = null;
    _state.sessionSpecId = null;
    return { session: null, spec: null, backend: 'classical', reason };
  }
}

// ===================== 便捷入口：取得「可直接喂给 segment 的 session+spec」 =====================
// segment({ session, spec }) —— 没有模型时 session 为 null，segment 自动走经典基线。
export async function prepareModelForSegment() {
  const r = await getEdgeSession();
  return { session: r.session, spec: r.spec, backend: r.backend, reason: r.reason };
}
