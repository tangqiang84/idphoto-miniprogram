import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import './index.scss';

// 首页 = 工具箱枢纽：各小工具独立进入、互不依赖（PRD 模块 J）
const TOOLS = [
  { id: 'T1', title: '一键证件照', desc: '拍照/上传 → 抠图换底 → 选规格 → 导出', icon: '🪪', path: '/pages/tool-idphoto/index', tag: '完整流程' },
  { id: 'T2', title: '单独换底色', desc: '已有照片，只换红/蓝/白底', icon: '🎨', path: '/pages/tool-bg/index', tag: '换底' },
  { id: 'T3', title: 'AI 换装', desc: '职业装一键合成（独立授权）', icon: '👔', path: '/pages/tool-suit/index', tag: '换装' },
  { id: 'T4', title: '合规检测', desc: '只读检测头部占比/像素/KB/底色', icon: '✅', path: '/pages/tool-check/index', tag: '检测' },
  { id: 'T5', title: '规格转换', desc: '按规格裁剪 / 改 dpi / 压 KB', icon: '📐', path: '/pages/tool-spec/index', tag: '转换' },
  // T6 冲印排版（PRD K1 独立工具）：首页入口此前缺失 → 任务 #49
  { id: 'T6', title: '冲印排版', desc: '已做好的证件照平铺到相纸，导出可打印拼版图', icon: '🖨️', path: '/pages/tool-print/index', tag: '排版' },
];

export default function Home() {
  const go = (path: string) => Taro.navigateTo({ url: path });

  return (
    <View className='home'>
      <View className='home__hero'>
        {/* hero 标题 = 注册名称，必须与后台名称一致（官方《常见拒绝情形》1.2.1，任务 #47） */}
        <Text className='home__hero-title'>标准照裁剪</Text>
        <Text className='home__hero-sub'>本地优先 · 隐私合规 · 即用即走</Text>
        {/* 免费承诺（owner 2026-10-23 决策：MVP 不设付费档，全部功能免费）
            竞品调研显示「透明定价、零套路」正是本产品相对同类的差异化信任信号；
            个人主体也无法开通微信支付（问题台账 #14），不做付费入口。 */}
        <View className='home__free-badge'>
          <Text className='home__free-badge-text'>全部功能免费 · 无水印 · 300/600dpi 均开放</Text>
        </View>
      </View>

      <View className='home__grid'>
        {TOOLS.map((t) => (
          <View key={t.id} className='tool-card' onClick={() => go(t.path)}>
            <View className='tool-card__top'>
              <Text className='tool-card__icon'>{t.icon}</Text>
              <Text className='tool-card__tag'>{t.tag}</Text>
            </View>
            <Text className='tool-card__title'>{t.title}</Text>
            <Text className='tool-card__desc'>{t.desc}</Text>
          </View>
        ))}
      </View>

      <View className='home__privacy' onClick={() => go('/pages/privacy/index')}>
        <Text className='home__privacy-title'>隐私承诺</Text>
        <Text className='home__privacy-text'>
          人脸仅在设备本地处理；上云增强仅上传裁剪后的人像区域，境内处理、用完即销毁、不训练。换装须单独授权。
        </Text>
        <Text className='home__privacy-link'>查看〈隐私政策〉全文 ›</Text>
      </View>
    </View>
  );
}
