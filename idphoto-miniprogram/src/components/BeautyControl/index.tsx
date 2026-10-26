import { View, Text, Slider, Button } from '@tarojs/components';
import { useState } from 'react';

export interface BeautyState {
  enabled: boolean;
  /** 磨皮强度 0..1（轻度） */
  smooth: number;
  /** 美白强度 0..1（轻度） */
  whiten: number;
  /** 亮眼强度 0..1（轻度，全局非锐化，无眼部 landmark） */
  brighten: number;
}

interface Props {
  value: BeautyState;
  onChange: (v: BeautyState) => void;
  /** 应用美颜并重新生成（父组件据此对当前图重跑处理管线） */
  onApply: () => void;
}

function toPct(v: number) {
  return Math.round((v || 0) * 100);
}

/**
 * 受限美颜控制面板（PRD E 章 / AC2 / E1 / E2，任务 #38）
 * - 折叠项：默认关闭，用户点标题开启。
 * - 仅提供 E1 允许项（磨皮/美白/亮眼，轻度滑块）。
 * - E2 禁止项（瘦脸/大眼/重塑五官）以置灰文案呈现且不可点，并说明合规原因（AC2 验收）。
 */
export default function BeautyControl({ value, onChange, onApply }: Props) {
  const set = (patch: Partial<BeautyState>) => onChange({ ...value, ...patch });

  return (
    <View className='beauty'>
      <View className='beauty__head' onClick={() => set({ enabled: !value.enabled })}>
        <Text className='beauty__title'>美颜（受限）</Text>
        <Text className={`beauty__switch ${value.enabled ? 'is-on' : ''}`}>
          {value.enabled ? '已开启 ▾' : '已关闭 ▸'}
        </Text>
      </View>

      {value.enabled ? (
        <View className='beauty__panel'>
          <Text className='beauty__hint'>
            合规模式：仅提供磨皮 / 美白 / 亮眼（轻度）；瘦脸、大眼、重塑五官已禁用
          </Text>

          <View className='beauty__row'>
            <Text className='beauty__label'>磨皮</Text>
            <Slider
              className='beauty__slider'
              min={0}
              max={100}
              value={toPct(value.smooth)}
              onChange={(e: any) => set({ smooth: (e.detail.value || 0) / 100 })}
            />
          </View>
          <View className='beauty__row'>
            <Text className='beauty__label'>美白</Text>
            <Slider
              className='beauty__slider'
              min={0}
              max={100}
              value={toPct(value.whiten)}
              onChange={(e: any) => set({ whiten: (e.detail.value || 0) / 100 })}
            />
          </View>
          <View className='beauty__row'>
            <Text className='beauty__label'>亮眼</Text>
            <Slider
              className='beauty__slider'
              min={0}
              max={100}
              value={toPct(value.brighten)}
              onChange={(e: any) => set({ brighten: (e.detail.value || 0) / 100 })}
            />
          </View>

          {/* E2 禁止项：置灰且不可点（AC2 验收：禁用项不可点） */}
          <View className='beauty__forbidden'>
            <Text className='beauty__forbidden-title'>瘦脸 / 大眼 / 重塑五官</Text>
            <Text className='beauty__forbidden-tip'>
              合规模式已禁用（为保证审核通过，禁止改动五官）
            </Text>
          </View>

          <Button className='beauty__apply' onClick={onApply}>
            应用美颜并重新生成
          </Button>
        </View>
      ) : null}
    </View>
  );
}
