// 上云增强：CloudBase 原生调用封装（wx.cloud.callFunction）
// 满足 src/core/mattingCloud.cloudMatting 的 adapter 契约：
//   { endpoint, trustedHosts, kind, call(req) -> { alphaB64, region } }
import Taro from '@tarojs/taro';

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
      const res: any = await Taro.cloud.callFunction({ name, data: req });
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
