import { View, Text } from '@tarojs/components';

/**
 * 裁剪步骤屏（P2.5 / `s_crop`，T1/T2/T3/T5 共用）
 *
 * 【统一模型（原型 v0.3 核心）】裁剪 = 先定目标规格 → 用**比例锁定该规格**的裁剪框选定画面范围。
 * 代码层的裁剪由 core/headCrop.js 的**智能构图**完成（按规格头占比区间反解裁剪框 + 面部水平居中），
 * 本组件把该结果**显式呈现**给用户：目标规格、裁剪框比例、实际头占比、是否降级。
 *
 * 【本轮范围（诚实标注）】原型里可拖动/缩放裁剪框（手动微调）**尚未接入代码**——
 * 手动裁剪需要把裁剪窗回灌到 pipeline 的 planWindowOutput（新增「用户指定裁剪窗」入参），
 * 工程量与回归面都大于本轮。本轮交付：步骤屏 + 比例锁定 + 智能构图结果透明化；
 * 手动微调列入后续（台账登记）。**不把未实现的交互说成已实现**。
 */

interface Props {
  /** 规格显示名 */
  specName: string;
  /** 目标像素 */
  target: { width: number; height: number } | null;
  /** 智能裁切结果（core/headCrop.planHeadCrop 的返回，null = 未检出人脸已降级居中裁剪） */
  crop?: any;
}

export default function CropStep({ specName, target, crop }: Props) {
  const ratio = target ? `${target.width}:${target.height}` : '—';
  const headTargetPct = crop && typeof crop.ratioTarget === 'number'
    ? `${(crop.ratioTarget * 100).toFixed(0)}%`
    : '—';
  const headRealPct = crop && typeof crop.ratioAchieved === 'number'
    ? `${(crop.ratioAchieved * 100).toFixed(0)}%`
    : '—';

  return (
    <View className='step-crop' data-step='crop'>
      <View className='step-crop__head'>
        <Text className='step-crop__title'>① 裁剪（按所选规格选取画面范围）</Text>
        <Text className='step-crop__sub'>目标规格：{specName}</Text>
      </View>

      <View className='step-crop__info'>
        <Text className='step-crop__row'>裁剪框比例已锁定 {ratio}（缩放不改变比例，成品不会被拉伸变形）</Text>
        {target ? (
          <Text className='step-crop__row'>目标像素：{target.width}×{target.height}px</Text>
        ) : null}
        {crop ? (
          <Text className='step-crop__row'>
            {'头部占比：目标 '}{headTargetPct}{' → 实测 '}{headRealPct}
            {crop.degraded ? '（原片构图不足，已按最佳可达值出图）' : '（构图达标）'}
          </Text>
        ) : (
          <Text className='step-crop__row step-crop__row--muted'>
            尚未选图；选图后系统会按该规格的头占比区间自动构图
          </Text>
        )}
      </View>
    </View>
  );
}
