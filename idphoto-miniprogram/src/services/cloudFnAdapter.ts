// 上云增强：CloudBase 原生调用封装（wx.cloud.callFunction）
// 满足 src/core/mattingCloud.cloudMatting 的 adapter 契约：
//   { endpoint, trustedHosts, kind, call(req) -> { alphaB64, region } }
import Taro from '@tarojs/taro';
import { withTimeout, CLOUD_CALL_TIMEOUT_MS } from '../core/asyncUtils';

export interface CloudFnAdapterOpts {
  name?: string; // 云函数名，默认 'matting'
  authToken?: string;
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
      // #70：无超时的 callFunction 在真机上可能永悬（网络 stall / 冷启动挂起）→ 页面
      // busy 永不复位（owner 2026-10-27 真机实测「一直在处理中」）。超时抛错后
      // segment() 会捕获并降级出图，状态行带原因码，用户不再面对无限转圈。
      const res: any = await withTimeout(
        Taro.cloud.callFunction({ name, data: req }),
        CLOUD_CALL_TIMEOUT_MS,
        'cloudfn: 云端响应超时',
      );
      const result = (res && res.result) || {};
      if (result.error) throw new Error('cloudfn: ' + result.error);
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
