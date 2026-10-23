import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { requiredConsents, buildConsentRecord } from '../../services';

// T3 AI 换装：核心功能，须独立单独授权（faceCloudEnhance + suitSwap）。
const SUITS = ['职业正装', '白领衬衫', '学士服', '公务员西装', '教师装'];

export default function ToolSuit() {
  const tool = 'T3';
  const consents = requiredConsents(tool);
  const rec = buildConsentRecord(tool, consents.map((c) => c.id));

  const apply = (suit: string) => {
    if (!rec.ready) {
      Taro.showToast({ title: '换装需单独授权', icon: 'none' });
      return;
    }
    Taro.showModal({
      title: '合规提示',
      content: `已应用「${suit}」。请确认仅换装、未改动五官，否则报名审核可能驳回。`,
      showCancel: false,
    });
  };

  return (
    <View className='page'>
      <Text className='page__title'>AI 换装</Text>
      <View className='consent'>
        <Text className='consent__h'>换装需单独授权</Text>
        {consents.map((c) => (
          <View key={c.id} className='consent__item'>
            <Text className='consent__label'>{c.label}</Text>
            <Text className='consent__desc'>{c.desc}</Text>
          </View>
        ))}
      </View>
      <View className='suit-list'>
        {SUITS.map((s) => (
          <View key={s} className='suit-item' onClick={() => apply(s)}>
            <Text>{s}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
