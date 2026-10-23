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
      return { alphaB64: result.alphaB64 || result.alpha, region: result.region || 'CN' };
    },
  };
}
