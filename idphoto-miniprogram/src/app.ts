import { PropsWithChildren } from 'react';
import Taro from '@tarojs/taro';
import { useLaunch } from '@tarojs/taro';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // CloudBase 云开发初始化（路1：原生调用，后台合法域名零配置）
    Taro.cloud.init({ env: 'baochengtang-d7g6ki1ch79dc2faa' });
    console.log('App launched.');
  });
  return children;
}
