import { PropsWithChildren } from 'react';
import Taro from '@tarojs/taro';
import { useLaunch } from '@tarojs/taro';
// 【问题 #89 根治】Taro 3 中 `src/app.scss` **不是自动入口**，必须在 app 入口显式 import。
// 缺失后果：`dist/app-origin.wxss` 为 0 字节 → 全局样式（.page / .btn-primary / .consent /
// .status-line …）全部丢失，页面看起来"简陋"，且工具页（无自己的 index.scss）完全裸奔。
import './app.scss';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // CloudBase 云开发初始化（路1：原生调用，后台合法域名零配置）
    Taro.cloud.init({ env: 'baochengtang-d7g6ki1ch79dc2faa' });
    console.log('App launched.');
  });
  return children;
}
