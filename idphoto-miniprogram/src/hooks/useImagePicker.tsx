import { useState, type ReactElement } from 'react';
import Taro from '@tarojs/taro';
import CameraGuide from '../components/CameraGuide';

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
}

/**
 * 统一「从相册选择」与「拍摄（A1 半透明人脸引导框）」两个取图入口。
 *
 * - pickAlbum：Taro.chooseImage sourceType=['album']（剥离 camera，避免原生相机无法叠加引导框）；
 *   并在用户取消时不报错。保留相册入口以便自动化冒烟 mock chooseImage。
 * - openCamera：打开页面内 <camera> 实时预览 + cover-view 引导框；拍照后 onCapture 回传临时路径。
 *
 * 各工具传入的 onImage 为「已剥离取图逻辑」的真实处理入口（读图 → 处理），
 * 由本 hook 在相册/拍照两种路径拿到路径与尺寸后统一调用。
 */
export function useImagePicker(
  onImage: (img: PickedImage) => void | Promise<void>,
): ImagePicker {
  const [cameraOpen, setCameraOpen] = useState(false);

  const pickAlbum = async () => {
    try {
      const pick: any = await Taro.chooseImage({
        count: 1,
        sizeType: ['original'],
        sourceType: ['album'],
      });
      const path = pick.tempFilePaths[0];
      const info: any = await Taro.getImageInfo({ src: path });
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
    try {
      const info: any = await Taro.getImageInfo({ src: path });
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

  return { pickAlbum, openCamera, closeCamera, cameraOpen, Guide };
}
