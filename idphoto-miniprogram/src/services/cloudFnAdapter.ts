// 上云增强：CloudBase 原生调用封装（wx.cloud.callFunction）
// 满足 src/core/mattingCloud.cloudMatting 的 adapter 契约：
//   { endpoint, trustedHosts, kind, call(req) -> { alphaB64, region } }
import Taro from '@tarojs/taro';
import { withTimeout, CLOUD_CALL_TIMEOUT_MS } from '../core/asyncUtils';

export interface CloudFnAdapterOpts {
  name?: string; // 云函数名，默认 'matting'
  authToken?: string;
  authorization?: { check(): void; traceId?: string };
  resultType?: 'matting' | 'raw';
  onDiagnostic?: (record: { phase: string; sdkCode: number | null; traceId: string; elapsedMs: number; taskTraceId: string | null; cloudTraceId: string | null }) => void;
}

export function makeCloudFnAdapter(opts: CloudFnAdapterOpts = {}) {
  const name = opts.name || 'matting';
  // cloud:// 协议由 CloudBase 境内环境保证，数据不出境；mattingCloud.assertDomestic 已对其豁免
  const endpoint = 'cloud://CN';
  return {
    endpoint,
    trustedHosts: ['cloud://CN'],
    kind: 'cloudfn' as const,
    async call(req: any) {
      const started = Date.now();
      const traceId = 'cloud-' + started + '-' + Math.random().toString(36).slice(2, 10);
      if (!opts.authorization) throw { code: 'CONSENT_REQUIRED', message: '请单独同意上云增强', traceId, retryable: false };
      opts.authorization.check();
      const taskTraceId = /^T[1-6]-\d{13}-\d{1,10}-\d{1,10}$/.test(opts.authorization.traceId || '') ? opts.authorization.traceId! : null;
      const numericCode = (value: any): number | null => {
        if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d{1,12}$/.test(value))) return null;
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : null;
      };
      const observe = (phase: string, sdkCode: number | null, candidate?: unknown) => {
        const cloudTraceId = typeof candidate === 'string' && /^(?:matting(?:-cap)?-\d{13}-[a-f0-9]{8}|pose-[a-f0-9]{16}|(?:facepoints|face|suitparse|suitfit)-[a-f0-9]{32})$/.test(candidate) ? candidate : null;
        const record = { phase, sdkCode, traceId, taskTraceId, cloudTraceId, elapsedMs: Date.now() - started };
        try { opts.onDiagnostic?.(record); } catch { /* 诊断观察失败不改变处理结果。 */ }
        if (phase !== 'RESULT_RETURNED') console.warn('[cloud-adapter]', record);
        else if (cloudTraceId) console.info('[cloud-adapter]', record);
      };
      // #70：无超时的 callFunction 在真机上可能永悬（网络 stall / 冷启动挂起）→ 页面
      // busy 永不复位（owner 2026-10-27 真机实测「一直在处理中」）。超时抛错后
      // segment() 会捕获并降级出图，状态行带原因码，用户不再面对无限转圈。
      let res: any;
      try { res = await withTimeout(
        new Promise((resolve, reject) => {
          // 同时接住SDK回调和Promise；原生Promise保证重复通知只结算一次。
          const pending: unknown = Taro.cloud.callFunction({ name, data: req,
            success: resolve, fail: reject });
          const promise = pending as PromiseLike<unknown> | undefined;
          if (promise && typeof promise.then === 'function') promise.then(resolve, reject);
        }),
        CLOUD_CALL_TIMEOUT_MS,
        'cloudfn: 云端响应超时',
      ); } catch (error: any) {
        const timeout = error?.code === 'ASYNC_TIMEOUT' || /timeout|超时/i.test(String(error?.message || error?.errMsg || ''));
        const sdkCode = numericCode(error?.errCode ?? error?.code);
        observe(timeout ? 'TIMEOUT' : 'SDK_REJECTED', sdkCode);
        throw { code: sdkCode ?? (timeout ? 'CLOUD_TIMEOUT' : 'CLOUD_SDK_REJECTED'),
          message: timeout ? '云端响应超时，请重试' : '上云服务暂不可用，请稍后重试', traceId, retryable: true };
      }
      opts.authorization.check();
      const result = (res && res.result) || {};
      if (opts.resultType === 'raw') { observe(result.ok === false ? 'FUNCTION_ERROR' : 'RESULT_RETURNED', numericCode(result.code), result.traceId); return result; }
      if (result.error) {
        const sdkCode = numericCode(result.code);
        observe('FUNCTION_ERROR', sdkCode, result.traceId);
        throw { code: sdkCode ?? 'CLOUD_FUNCTION_ERROR', message: '上云服务暂不可用，请稍后重试',
          traceId, retryable: ![400, 403, 451].includes(sdkCode ?? 0) };
      }
      observe('RESULT_RETURNED', null, result.traceId);
      // provider 用于前端判断「这次结果来自真模型还是影子实现」：
      //  - 'baidu'          百度智能云人像分割（真模型）
      //  - 'shadow'         云函数 CPU 影子实现（含百度失败后的降级）
      //  - 'birefnet'       未来自有 GPU 实例
      // 前端据此选择云端 alpha 的接受判据（core/mattingCloud.shouldAcceptCloudAlpha）。
      return {
        alphaB64: result.alphaB64 || result.alpha,
        region: result.region || 'CN',
        provider: result.provider || null,
        providerMeta: result.providerMeta || null,
      };
    },
  };
}
