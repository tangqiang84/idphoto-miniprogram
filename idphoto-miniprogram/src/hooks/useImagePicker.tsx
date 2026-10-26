import { useState, type ReactElement } from 'react';
import Taro from '@tarojs/taro';
import CameraGuide from '../components/CameraGuide';
import QualityTip, { type QualityTipProps } from '../components/QualityTip';
import MirrorCheck from '../components/MirrorCheck';
import { assessQuality } from '../core/quality';

export interface PickedImage {
  path: string;
  width: number;
  height: number;
}

export interface ImagePicker {
  /** 从相册选择（仅 album），用于常规取图与自动化冒烟（mock chooseImage） */
  pickAlbum: () => Promise<void>;
  /** 打开 in-page 相机 + 半透明人脸引导框（PRD A1） */
  openCamera: () => void;
  /** 关闭相机引导框 */
  closeCamera: () => void;
  cameraOpen: boolean;
  /** 引导框组件，渲染在页面根 View 内即可 */
  Guide: ReactElement;
  /** 最近一次取图的质量评估结果（PRD A3 / AC3），null 表示未评估/评估失败 */
  quality: QualityTipProps['quality'];
  /** 质量提示条组件，渲染在页面根 View 内即可（非阻断） */
  QualityTip: ReactElement;
  /** 镜像自查确认态（AC1 务实方案：导出前用户自查勾选，类比 T3 自检） */
  mirrorConfirmed: boolean;
  /** 设置镜像自查确认态 */
  setMirrorConfirmed: (v: boolean) => void;
  /** 镜像自查条组件，渲染在「已出图待导出」区域即可（勾选前父组件应禁用其 save/export） */
  MirrorCheck: ReactElement;
}

const SAMPLE_SIZE = 64; // 端侧下采样尺寸，足够判断背景复杂度与亮度

/**
 * 取图后即时做原图质量评估（PRD A3 / AC3）：分辨率、背景复杂度、光线。
 * 评估失败（端侧取像素不可用、算法异常）一律静默降级，绝不阻断主处理流程。
 */
async function samplePixels(path: string): Promise<Uint8ClampedArray | null> {
  try {
    const anyTaro: any = Taro;
    if (typeof anyTaro.createOffscreenCanvas !== 'function') return null;
    const cv = anyTaro.createOffscreenCanvas({
      type: '2d',
      width: SAMPLE_SIZE,
      height: SAMPLE_SIZE,
    });
    const cx = cv.getContext('2d');
    const im = cv.createImage();
    await new Promise<void>((resolve, reject) => {
      im.onload = () => resolve();
      im.onerror = (e: any) => reject(e || new Error('图片加载失败'));
      im.src = path;
    });
    cx.drawImage(im, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const id = cx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return id.data;
  } catch (e) {
    return null; // 静默降级
  }
}

/**
 * 统一「从相册选择」与「拍摄（A1 半透明人脸引导框）」两个取图入口。
 *
 * - pickAlbum：Taro.chooseImage sourceType=['album']（剥离 camera，避免原生相机无法叠加引导框）；
 *   并在用户取消时不报错。保留相册入口以便自动化冒烟 mock chooseImage。
 * - openCamera：打开页面内 <camera> 实时预览 + cover-view 引导框；拍照后 onCapture 回传临时路径。
 * - 两种路径取到图后都会即时做质量评估（assessQuality），结果通过 QualityTip 非阻断展示。
 *
 * 各工具传入的 onImage 为「已剥离取图逻辑」的真实处理入口（读图 → 处理），
 * 由本 hook 在相册/拍照两种路径拿到路径与尺寸后统一调用。
 */
export function useImagePicker(
  onImage: (img: PickedImage) => void | Promise<void>,
): ImagePicker {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [quality, setQuality] = useState<QualityTipProps['quality']>(null);
  const [mirrorConfirmed, setMirrorConfirmed] = useState(false);

  const evaluate = async (path: string, w: number, h: number) => {
    setQuality(null);
    const rgba = await samplePixels(path);
    if (!rgba) return; // 取不到像素 → 不提示
    try {
      setQuality(assessQuality(rgba, SAMPLE_SIZE, SAMPLE_SIZE, w, h));
    } catch (e) {
      // 算法异常也不阻断
    }
  };

  const pickAlbum = async () => {
    setMirrorConfirmed(false); // 重新取图须重新自查（AC1）
    try {
      const pick: any = await Taro.chooseImage({
        count: 1,
        sizeType: ['original'],
        sourceType: ['album'],
      });
      const path = pick.tempFilePaths[0];
      const info: any = await Taro.getImageInfo({ src: path });
      await evaluate(path, info.width, info.height);
      await onImage({ path, width: info.width, height: info.height });
    } catch (e: any) {
      const m = String((e && e.message) || e);
      // 用户主动取消（cancel / 取消）不提示，其余读取失败给轻提示
      if (!/cancel|取消/.test(m)) {
        Taro.showToast({ title: '读取图片失败，请重试', icon: 'none' });
      }
    }
  };

  const openCamera = () => setCameraOpen(true);
  const closeCamera = () => setCameraOpen(false);

  const handleCapture = async (path: string) => {
    setCameraOpen(false);
    setMirrorConfirmed(false); // 重新取图须重新自查（AC1）
    try {
      const info: any = await Taro.getImageInfo({ src: path });
      await evaluate(path, info.width, info.height);
      await onImage({ path, width: info.width, height: info.height });
    } catch (e) {
      Taro.showToast({ title: '读取照片失败，请重试', icon: 'none' });
    }
  };

  const Guide = (
    <CameraGuide
      visible={cameraOpen}
      onCapture={handleCapture}
      onCancel={closeCamera}
    />
  );

  const QualityTipEl = <QualityTip quality={quality} />;

  const MirrorCheckEl = (
    <MirrorCheck confirmed={mirrorConfirmed} onChange={setMirrorConfirmed} />
  );

  return {
    pickAlbum,
    openCamera,
    closeCamera,
    cameraOpen,
    Guide,
    quality,
    QualityTip: QualityTipEl,
    mirrorConfirmed,
    setMirrorConfirmed,
    MirrorCheck: MirrorCheckEl,
  };
}
