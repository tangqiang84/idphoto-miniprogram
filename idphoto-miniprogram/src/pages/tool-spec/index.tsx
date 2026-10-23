import { View, Text } from '@tarojs/components';
import { listSpecs, getPixelSize, DPI_STD, DPI_HD } from '../../services';

// T5 规格转换：按规格裁剪 / 改 dpi / 压 KB（无需人脸授权，AC9）。
// 演示真实调用 core/specLibrary 计算像素尺寸。
export default function ToolSpec() {
  const specs = listSpecs();

  return (
    <View className='page'>
      <Text className='page__title'>规格转换</Text>
      <Text className='page__hint'>按目标规格裁剪 / 改 dpi / 压 KB。无需人脸授权。</Text>

      <View className='spec-list'>
        {specs.map((s) => {
          const std = getPixelSize(s.id, DPI_STD);
          const hd = getPixelSize(s.id, DPI_HD);
          return (
            <View className='spec-item' key={s.id}>
              <Text className='spec-name'>{s.name}</Text>
              <Text className='spec-size'>{std.width}×{std.height}px @300dpi（免费档）</Text>
              <Text className='spec-size'>{hd.width}×{hd.height}px @600dpi（高清档）</Text>
              <Text className='spec-size'>{s.note}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
