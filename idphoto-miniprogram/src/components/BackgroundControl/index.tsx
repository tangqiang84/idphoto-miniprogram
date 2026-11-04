import { View, Text, Input, Button } from '@tarojs/components';
import { useState } from 'react';
import { parseColorInput, resolveBackground } from '../../core/color';
import { BG } from '../../core/specLibrary';

export default function BackgroundControl({ value, onChange }: { value: any; onChange: (value: any) => void }) {
  const [color, setColor] = useState('#FFFFFF');
  const [end, setEnd] = useState('#438EDB');
  const [angle, setAngle] = useState('90');
  const [error, setError] = useState('');
  const apply = (gradient: boolean) => {
    const first = parseColorInput(color); const last = parseColorInput(end);
    const degrees = Number(angle);
    if (!first || gradient && (!last || !angle.trim() || !Number.isFinite(degrees))) { setError('请输入有效HEX或RGB（0–255），渐变角度须为数值'); return; }
    setError(''); onChange(gradient ? { type: 'gradient', from: first.hex, to: last.hex, angle: degrees } : first.hex);
  };
  const resolved = resolveBackground(BG[value] || value);
  const background = resolved.type === 'gradient' ? `linear-gradient(${90 + resolved.angle}deg, ${resolved.from.hex}, ${resolved.to.hex})` : resolved.type === 'solid' ? resolved.hex : 'transparent';
  return <View className='background-control'>
    <Text>底色：HEX 或 RGB，如 #438EDB、67,142,219；RGB须在0–255范围</Text>
    <Input className='color-input' value={color} onInput={(e) => setColor(e.detail.value)} />
    <Button className='color-solid' onClick={() => apply(false)}>应用纯色</Button>
    <Text>渐变终点与角度（0°从左到右，90°从上到下）</Text>
    <Input className='color-end' value={end} onInput={(e) => setEnd(e.detail.value)} />
    <Input className='color-angle' value={angle} onInput={(e) => setAngle(e.detail.value)} />
    <Button className='color-gradient' onClick={() => apply(true)}>应用渐变</Button>
    <Button className='color-transparent' onClick={() => { setError(''); onChange(null); }}>透明底 PNG</Button>
    <View className='color-sample' style={{ background, height: '48px' }} />
    {error ? <Text className='color-error'>{error}</Text> : null}
    <Text>自定义色、渐变或透明图片可能不符合目标证件底色要求；仅作为图像素材输出，不表示证件合规。</Text>
  </View>;
}
