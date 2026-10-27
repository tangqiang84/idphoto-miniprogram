// 选图前协议闸门（P1 / 台账 #76，方案 [F3]）
//
// 【为什么】个保法「先同意、后收集」：授权勾选必须在**收集（选图/拍照）之前**完成。
// 原实现把闸门放在处理起点（run() 内 rec.ready）——用户能先选图、再被拦，
// 顺序上说不通（照片已被读取），也容易在真机上留下「已选图但没跑」的困惑态。
// 本 hook 把闸门**前移到选图入口**：未勾选 → 选图/拍摄按钮不可达（点击给提示 + 高亮勾选区）。
//
// 【双闸门保留】run() 内的 rec.ready 检查不删除——它是**兜底**（防止其它入口绕过），
// 本 hook 是**前置**（体验与合规顺序）。两道都在，任一道拦截即不进入处理链路。
import Taro from '@tarojs/taro';
import { useState } from 'react';

export interface ConsentGate {
  /** 是否已触发过一次拦截（用于高亮协议区） */
  hinted: boolean;
  /** 包裹选图/拍摄入口：未集齐授权即拦截 */
  gate: (fn: () => void) => void;
  /** 未集齐授权（用于按钮置灰） */
  blocked: boolean;
}

export function useConsentGate(ready: boolean, toolLabel = '处理'): ConsentGate {
  const [hinted, setHinted] = useState(false);
  const gate = (fn: () => void) => {
    if (!ready) {
      setHinted(true);
      Taro.showToast({
        title: `请先勾选上方所需的授权（${toolLabel}需要你先同意，才会读取照片）`,
        icon: 'none',
      });
      return;
    }
    setHinted(false);
    fn();
  };
  return { hinted, gate, blocked: !ready };
}
