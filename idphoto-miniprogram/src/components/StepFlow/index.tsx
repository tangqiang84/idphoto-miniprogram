import { View, Text } from '@tarojs/components';

/**
 * 管线步骤指示器（P1 任务 #77 / 原型 v0.4 `s_*` 步骤屏）
 *
 * 【为什么需要】v0.4 把流程固定为「裁剪 → 美颜 → 抠图换底 →（换装）→ 预审 → dpi → 导出」，
 * 但代码层各页仍是"一次处理跑到底"，用户看不到当前走到哪一步、也不知道顺序是否统一。
 * 本组件把顺序**显式渲染出来**，同时给冒烟脚本一个可断言的锚点（.step-flow__item[data-step]）。
 *
 * 【RC 验收对应】RC-1（美颜在裁剪后、抠图前）、RC-3（dpi 是独立步骤）、
 * RC-5/RC-6/RC-8/RC-9（各工具顺序一致、无私自调整）——都由本页 + 各页步骤区块共同满足。
 */

export interface StepDef {
  /** 步骤标识（冒烟断言用 data-step） */
  key: string;
  /** 展示名 */
  label: string;
  /** 可选：副标题/说明 */
  hint?: string;
}

interface Props {
  steps: StepDef[];
  /** 当前步骤序号（0 起）；-1 = 尚未开始，steps.length = 已完成 */
  current?: number;
}

export default function StepFlow({ steps, current = -1 }: Props) {
  return (
    <View className='step-flow'>
      {steps.map((s, i) => {
        const done = current >= 0 && i < current;
        const cur = i === current;
        return (
          <View
            key={s.key}
            className={`step-flow__item${done ? ' is-done' : ''}${cur ? ' is-current' : ''}`}
            data-step={s.key}
          >
            <Text className='step-flow__idx'>{done ? '✓' : String(i + 1)}</Text>
            <Text className='step-flow__label'>{s.label}</Text>
          </View>
        );
      })}
    </View>
  );
}
