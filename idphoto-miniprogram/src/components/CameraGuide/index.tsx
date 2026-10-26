import { View, Camera, CoverView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import './index.scss';

interface Props {
  /** 是否显示相机引导框 */
  visible: boolean;
  /** 拍照成功回传临时文件路径 */
  onCapture: (tempFilePath: string) => void;
  /** 取消 */
  onCancel: () => void;
}

/**
 * A1 半透明人脸引导框（PRD A1 / 任务 #37）。
 *
 * 实现要点：
 * - 微信原生相机无法通过 chooseImage 叠加 overlay，必须直接用 <camera> 原生组件拿到实时预览。
 * - 原生组件之上只能用 <cover-view> 覆盖（普通 View 会被压在相机下方）。
 * - 引导框为「头肩轮廓半透明描边 + 正脸/平视/光线提示」，不遮挡画面，纯视觉引导，
 *   不依赖人脸检测（PRD A1 仅要求提示，不要求自动识别，避免误判伤体验）。
 * - 支持前置/后置切换与闪光灯开关，适配不同拍摄习惯。
 */
export default function CameraGuide({ visible, onCapture, onCancel }: Props) {
  const [device, setDevice] = useState<'front' | 'back'>('front');
  const [flash, setFlash] = useState<'off' | 'on' | 'auto'>('off');

  if (!visible) return null;

  const take = () => {
    const ctx = Taro.createCameraContext();
    ctx.takePhoto({
      quality: 'high',
      success: (res: any) => onCapture(res.tempImagePath),
      fail: () => Taro.showToast({ title: '拍照失败，请重试', icon: 'none' }),
    });
  };

  const toggleFlash = () =>
    setFlash((f) => (f === 'off' ? 'on' : 'off'));
  const toggleDevice = () =>
    setDevice((d) => (d === 'front' ? 'back' : 'front'));

  return (
    <View className='cam-guide'>
      <Camera
        className='cam-guide__cam'
        devicePosition={device}
        flash={flash}
        resolution='high'
      >
        {/* 引导框：作为 camera 子节点，必然覆盖在预览之上 */}
        <CoverView className='cam-guide__frame'>
          <CoverView className='cam-guide__head' />
          <CoverView className='cam-guide__shoulders' />
        </CoverView>
        <CoverView className='cam-guide__tips'>
          请正脸平视 · 光线均匀 · 肩部入框
        </CoverView>
      </Camera>

      {/* 底部操作栏（cover-view 浮于相机之上） */}
      <CoverView className='cam-guide__bar'>
        <CoverView className='cam-guide__act' onClick={onCancel}>
          取消
        </CoverView>
        <CoverView className='cam-guide__shutter' onClick={take} />
        <CoverView className='cam-guide__act' onClick={toggleFlash}>
          {flash === 'off' ? '闪光关' : '闪光开'}
        </CoverView>
      </CoverView>

      {/* 翻转摄像头 */}
      <CoverView className='cam-guide__flip' onClick={toggleDevice}>
        {device === 'front' ? '后置' : '前置'}
      </CoverView>
    </View>
  );
}
