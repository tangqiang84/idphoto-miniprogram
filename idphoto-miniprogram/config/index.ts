import { defineConfig } from '@tarojs/cli';
import devConfig from './dev';
import prodConfig from './prod';

export default defineConfig(async (merge, { command, mode }) => {
  const baseConfig = {
    projectName: 'idphoto-miniprogram',
    date: '2026-10-22',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {},
    copy: { patterns: [], options: {} },
    framework: 'react',
    compiler: 'webpack5',
    cache: { enable: false },
    mini: {
      postcss: {
        autoprefixer: { enable: true },
        cssModules: { enable: false },
      },
    },
    h5: {},
  };
  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig);
  }
  return merge({}, baseConfig, prodConfig);
});
