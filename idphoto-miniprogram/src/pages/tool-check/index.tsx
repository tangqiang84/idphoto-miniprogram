import { View, Text, Button, Picker } from '@tarojs/components';
import { useState } from 'react';
import { listSpecs, getPixelSize, check } from '../../services';

// T4 合规检测：只读检测，不生成不改动（AC10）。
// 演示真实调用 core/compliance 引擎；真实测量由前端 CV 提供，
// 此处用与所选规格一致的模拟测量展示判定逻辑。
export default function ToolCheck() {
  const specs = listSpecs();
  const [idx, setIdx] = useState(0);
  const [result, setResult] = useState<ReturnType<typeof check> | null>(null);

  const spec = specs[idx];
  const target = getPixelSize(spec.id, 300);

  // 模拟一次"合格"测量（真实由相机/上传后 CV 测量得到）
  const mockMeasured = {
    widthPx: target.width,
    heightPx: target.height,
    dpi: 300,
    fileKb: 45,
    bg: 'white',
    headHeightRatio: 0.66,
  };

  const run = () => setResult(check(spec.id, mockMeasured));

  return (
    <View className='page'>
      <Text className='page__title'>合规检测</Text>
      <Text className='page__hint'>仅读取并报告，不生成、不改动照片。用于报名前自检。</Text>

      <Picker
        mode='selector'
        range={specs.map((s) => s.name)}
        value={idx}
        onChange={(e) => {
          setIdx(Number(e.detail.value));
          setResult(null);
        }}
      >
        <View className='consent__item'>
          <Text className='consent__label'>选择目标规格：{spec.name}</Text>
          <Text className='consent__desc'>点击切换（共 {specs.length} 项）</Text>
        </View>
      </Picker>

      <Button className='btn-primary' onClick={run}>模拟检测</Button>

      {result && (
        <View className='result'>
          <View className='result__row'>
            <Text>综合结论</Text>
            <Text className={result.pass ? 'result__ok' : 'result__bad'}>
              {result.pass ? '合规 ✓' : '不合规 ✗'}
            </Text>
          </View>
          {result.checks.map((c) => (
            <View className='result__row' key={c.key}>
              <Text>{c.label}</Text>
              <Text className={c.pass ? 'result__ok' : 'result__bad'}>
                {c.pass ? '通过' : '未通过'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
