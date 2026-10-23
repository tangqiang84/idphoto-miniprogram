import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { requiredConsents, buildConsentRecord, BG } from '../../services';

// T2 单独换底色：已有照片只换底，需 本地处理 + 上云增强 授权。
const BG_LIST = [
  { key: 'white', name: '白底', hex: BG.white },
  { key: 'blue', name: '蓝底', hex: BG.blue },
  { key: 'red', name: '红底', hex: BG.red },
];

export default function ToolBg() {
  const tool = 'T2';
  const consents = requiredConsents(tool);
  const rec = buildConsentRecord(tool, consents.map((c) => c.id));

  const choose = (name: string) => {
    if (!rec.ready) {
      Taro.showToast({ title: '请先完成隐私授权', icon: 'none' });
      return;
    }
    Taro.showToast({ title: `已选${name}（待接入抠图合成）`, icon: 'none' });
  };

  return (
    <View className='page'>
      <Text className='page__title'>单独换底色</Text>
      <Text className='page__hint'>上传一张已有照片，仅替换背景色，不改动五官。</Text>
      <View className='bg-list'>
        {BG_LIST.map((b) => (
          <View key={b.key} className='bg-item' onClick={() => choose(b.name)}>
            <View className='bg-swatch' style={{ background: b.hex }} />
            <Text className='bg-name'>{b.name}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
