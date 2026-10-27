import { View, Text, Image, Slider, Button, MovableArea, MovableView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useMemo, useState } from 'react';
import { clampCropWindow, centerCropWindow, sameCropWindow, MIN_CROP_EDGE } from '../../core/cropWindow';
import './index.scss';

/**
 * 裁剪步骤屏（P2.5 / `s_crop`，T1/T2/T3/T5 共用）—— **可交互**版本
 *
 * 【交互模型（对齐原型 s_crop）】
 *   · 照片上叠一个**比例锁定目标规格**的裁剪框（绿框 + 四角手柄）
 *   · 框内可**拖动**（换位置），底部滑块可**缩放**（只改大小、不改比例）
 *   · 点「应用这个范围」→ 把裁剪窗回灌给 pipeline（core/cropWindow.js 负责校正）→ 重新出图
 *   · 未手动调整时 = 智能构图的**系统建议**（core/headCrop.js 按规格头占比反解）
 *
 * 【为什么用 movable-view 而不是 touch 手写拖拽】
 *   movable-view 自带边界约束与惯性，坐标就是「显示坐标左上角」→ 与原图坐标的换算只有一次缩放，
 *   不会出现"缩放后左上角漂移"这类难查的偏差（#69 同类：几何口径要一次对齐，别让它漂）。
 *
 * 【坐标系】
 *   原图像素坐标（左上角原点）= state 里存的 cropWindow；
 *   显示坐标 = 原图坐标 × (dispW / srcW)。
 */

interface Props {
  /** 规格显示名 */
  specName: string;
  /** 目标像素 */
  target: { width: number; height: number } | null;
  /** 智能裁切结果（系统建议；null = 未检出人脸已降级居中裁剪） */
  crop?: any;
  /** 原图临时路径（可选；给了才显示可交互裁剪区） */
  imageSrc?: string | null;
  /** 原图像素尺寸 */
  srcW?: number;
  srcH?: number;
  /** 当前用户裁剪窗（原图像素坐标；null = 尚未手动调整） */
  cropWindow?: { x: number; y: number; w: number; h: number } | null;
  /** 用户拖动/缩放后回调（原图像素坐标） */
  onCropWindowChange?: (w: { x: number; y: number; w: number; h: number }) => void;
  /** 点「应用这个范围」→ 触发按用户范围重新出图 */
  onApplyCrop?: () => void;
  /** 缩略显示宽度（px，默认 屏宽−40） */
  stageWidth?: number;
}

export default function CropStep(props: Props) {
  const {
    specName, target, crop, imageSrc, srcW, srcH,
    cropWindow, onCropWindowChange, onApplyCrop,
  } = props;

  // 显示宽度：屏宽 − 40（页面左右留白），换算比例 = dispW / srcW
  const screenW = useMemo(() => {
    try {
      const info = Taro.getSystemInfoSync();
      return info.windowWidth || 375;
    } catch (e) {
      return 375;
    }
  }, []);
  const dispW = props.stageWidth || Math.max(220, screenW - 40);
  const ratio = target && target.height ? target.width / target.height : 3 / 4;
  const dispH = srcW && srcH ? Math.round(dispW * srcH / srcW) : Math.round(dispW / ratio);
  const k = srcW ? dispW / srcW : 1; // 显示 → 原图 的比例系数

  // 当前生效的裁剪窗：用户手动 > 智能构图建议 > 居中最大窗
  const active = useMemo(() => {
    if (cropWindow) return cropWindow;
    if (crop && crop.sx != null && crop.sw > 0) {
      return { x: crop.sx, y: crop.sy, w: crop.sw, h: crop.sh };
    }
    if (srcW && srcH) {
      const c = centerCropWindow(srcW, srcH, ratio);
      if (c) return { x: c.x, y: c.y, w: c.w, h: c.h };
    }
    return null;
  }, [cropWindow, crop, srcW, srcH, ratio]);

  // movable-view 拖动位置（显示坐标左上角）
  const [mv, setMv] = useState<{ x: number; y: number } | null>(null);
  // 缩放系数（相对系统建议框）
  const [zoom, setZoom] = useState(1);

  if (!target) {
    return (
      <View className='step-crop' data-step='crop'>
        <View className='step-crop__head'>
          <Text className='step-crop__title'>① 裁剪（按所选规格选取画面范围）</Text>
          <Text className='step-crop__sub'>目标规格：{specName}</Text>
        </View>
        <View className='step-crop__info'>
          <Text className='step-crop__row step-crop__row--muted'>尚未选择规格</Text>
        </View>
      </View>
    );
  }

  const ratioTxt = `${target.width}:${target.height}`;
  const achieved = crop && typeof crop.ratioAchieved === 'number'
    ? `${(crop.ratioAchieved * 100).toFixed(0)}%`
    : '—';
  const targetPct = crop && typeof crop.ratioTarget === 'number'
    ? `${(crop.ratioTarget * 100).toFixed(0)}%`
    : '—';

  // 可交互条件：原图已选 + 尺寸已知
  const canInteract = !!(imageSrc && srcW && srcH && active);

  // 显示坐标：裁剪框左上角（movable-view 位置）
  const boxX = mv ? mv.x : (active ? Math.round(active.x * k) : 0);
  const boxY = mv ? mv.y : (active ? Math.round(active.y * k) : 0);
  const boxW = active ? Math.max(24, Math.round(active.w * k * zoom)) : 0;
  const boxH = active ? Math.max(24, Math.round(active.h * k * zoom)) : 0;

  const handleMove = (e: any) => {
    const x = e.detail.x;
    const y = e.detail.y;
    setMv({ x, y });
    if (!active || !onCropWindowChange || !srcW || !srcH) return;
    // 显示 → 原图；缩放后的框尺寸也要回传（zoom 生效）
    const wSrc = boxW / k;
    const hSrc = boxH / k;
    const fixed = clampCropWindow({ x: x / k, y: y / k, w: wSrc, h: hSrc }, srcW, srcH, ratio);
    if (fixed) onCropWindowChange({ x: fixed.x, y: fixed.y, w: fixed.w, h: fixed.h });
  };

  const handleZoom = (val: number) => {
    const z = Math.max(0.3, Math.min(1, val / 100));
    setZoom(z);
    if (!active || !onCropWindowChange || !srcW || !srcH) return;
    // 以框中心为基准等比缩放
    const cx = active.x + active.w / 2;
    const cy = active.y + active.h / 2;
    const nw = active.w * z;
    const nh = active.h * z;
    const fixed = clampCropWindow({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }, srcW, srcH, ratio);
    if (fixed) onCropWindowChange({ x: fixed.x, y: fixed.y, w: fixed.w, h: fixed.h });
  };

  const changed = cropWindow && active ? !sameCropWindow(cropWindow, active) : false;

  return (
    <View className='step-crop' data-step='crop'>
      <View className='step-crop__head'>
        <Text className='step-crop__title'>① 裁剪（按所选规格选取画面范围）</Text>
        <Text className='step-crop__sub'>目标规格：{specName}</Text>
      </View>

      {/* 可交互裁剪区：照片 + 比例锁定的裁剪框（可拖动 / 滑块缩放） */}
      {canInteract ? (
        <View className='crop-stage-wrap'>
          {/* MovableArea/MovableView 用 Taro 官方组件封装（不能用小写内置标签：
              小写标签在 Taro 3.6 编译产物里**不生成模板** → 运行时
              "Template `tmpl_0_35` not found"，裁剪框整块渲染不出来） */}
          <MovableArea className='crop-stage' style={{ width: dispW + 'px', height: dispH + 'px' }}>
            <Image className='crop-stage__img' src={imageSrc as any} mode='aspectFill' style={{ width: dispW + 'px', height: dispH + 'px' }} />
            <MovableView
              className='crop-box'
              direction='all'
              x={boxX}
              y={boxY}
              style={{ width: boxW + 'px', height: boxH + 'px' }}
              onMove={handleMove}
              onChange={(e: any) => { if (e.detail && typeof e.detail.x === 'number') setMv({ x: e.detail.x, y: e.detail.y }); }}
            >
              <View className='crop-box__mask'>
                {/* 四角手柄：即使裁剪框接近满屏，也能一眼看出「可拖动的裁剪范围」 */}
                <View className='crop-box__corner crop-box__corner--tl' />
                <View className='crop-box__corner crop-box__corner--tr' />
                <View className='crop-box__corner crop-box__corner--bl' />
                <View className='crop-box__corner crop-box__corner--br' />
              </View>
            </MovableView>
          </MovableArea>
          <View className='crop-zoom'>
            <Text className='crop-zoom__label'>缩放</Text>
            <Slider
              className='crop-zoom__slider'
              min={30}
              max={100}
              value={Math.round(zoom * 100)}
              onChanging={(e: any) => handleZoom(e.detail.value || 100)}
              onChange={(e: any) => handleZoom(e.detail.value || 100)}
            />
            <Text className='crop-zoom__val'>{Math.round(zoom * 100)}%</Text>
          </View>
          {onApplyCrop ? (
            <Button
              className='crop-apply'
              onClick={onApplyCrop}
              disabled={!changed}
            >
              {changed ? '应用这个范围并重新出图' : '（未改动范围，当前用系统建议构图）'}
            </Button>
          ) : null}
        </View>
      ) : null}

      <View className='step-crop__info'>
        <Text className='step-crop__row'>裁剪框比例已锁定 {ratioTxt}（缩放只改大小不改比例，成品不会被拉伸变形）</Text>
        <Text className='step-crop__row'>目标像素：{target.width}×{target.height}px</Text>
        {crop && crop.manual ? (
          <Text className='step-crop__row'>已按你手动选取的范围裁剪</Text>
        ) : (
          <Text className='step-crop__row'>
            {'头部占比：目标 '}{targetPct}{' → 实测 '}{achieved}
            {crop && crop.degraded ? '（原片构图不足，已按最佳可达值出图）' : ''}
          </Text>
        )}
        {!canInteract ? (
          <Text className='step-crop__row step-crop__row--muted'>
            选图后可在此拖动裁剪框、自选画面范围（当前先按系统建议构图出图）
          </Text>
        ) : null}
      </View>
    </View>
  );
}
