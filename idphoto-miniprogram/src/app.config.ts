export default {
  cloud: true, // 启用微信云开发（CloudBase 原生调用，后台合法域名零配置）
  pages: [
    'pages/home/index',
    'pages/tool-idphoto/index',
    'pages/tool-bg/index',
    'pages/tool-suit/index',
    'pages/tool-check/index',
    'pages/tool-spec/index',
    'pages/tool-print/index',
    'pages/privacy/index',
  ],
  window: {
    navigationBarTitleText: '证件照工具箱',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f5f6f8',
  },
};
