import { View, Text } from '@tarojs/components';
import './index.scss';

export interface QualityTipItem {
  level: string;
  code: string;
  text: string;
}

export interface QualityTipProps {
  quality: { tips: QualityTipItem[] } | null;
}

/**
 * 原图质量提示条（PRD A3 / AC3）：非阻断、建议性提示。
 * 不阻断导出（与 T1-21 构图不足同口径，owner 决策：出图 + 提示，让用户知情后自决）。
 * quality 为 null 或 tips 为空时不渲染。
 */
export default function QualityTip({ quality }: QualityTipProps) {
  if (!quality || !quality.tips || quality.tips.length === 0) return null;
  return (
    <View className='quality-tip'>
      <View className='quality-tip__title'>原图质量提示（不影响出图，可作参考）</View>
      {quality.tips.map((t, i) => (
        <View key={t.code || i} className='quality-tip__item'>
          <Text className='quality-tip__icon'>⚠️</Text>
          <Text className='quality-tip__text'>{t.text}</Text>
        </View>
      ))}
    </View>
  );
}
