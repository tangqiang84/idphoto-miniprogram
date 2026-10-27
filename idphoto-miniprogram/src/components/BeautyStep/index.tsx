import { View, Text } from '@tarojs/components';
import BeautyControl, { type BeautyState } from '../BeautyControl';

/**
 * 美颜步骤屏（P2.6 / `s_beauty`，裁剪后、抠图换底前，T1/T2/T3 共用）
 *
 * 【位置是硬约束】v0.4 起美颜必须**位于裁剪之后、抠图换底之前**（RC-1）：
 * 裁剪前的美颜会作用在最终会被裁掉的区域上（浪费算力、且可能在裁剪边界留下处理痕迹）。
 * 本组件在 UI 上把这个位置写死，并在页面的步骤指示器里排在第 ② 位。
 *
 * 【合规约束（RC-2）】只提供磨皮 / 美白 / 轻度亮眼；瘦脸 / 大眼 / 重塑五官禁用——
 * 端侧 core/beauty.js 的 assertCompliance 在 COMPLIANCE_MODE 下会抛错硬拦截（不靠 UI 自觉）。
 */

interface Props {
  value: BeautyState;
  onChange: (v: BeautyState) => void;
  /** 应用美颜并重跑管线 */
  onApply: () => void;
}

export default function BeautyStep({ value, onChange, onApply }: Props) {
  return (
    <View className='step-beauty' data-step='beauty'>
      <View className='step-beauty__head'>
        <Text className='step-beauty__title'>② 美颜修图（合规模式）</Text>
        <Text className='step-beauty__sub'>位于裁剪之后、抠图换底之前 · 仅轻度皮肤优化，不改脸型五官</Text>
      </View>
      <BeautyControl value={value} onChange={onChange} onApply={onApply} />
    </View>
  );
}
