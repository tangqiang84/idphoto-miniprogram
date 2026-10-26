import { View } from '@tarojs/components';
import './index.scss';

interface Props {
  /** 是否已确认照片非镜像照 */
  confirmed: boolean;
  /** 勾选状态变化回调 */
  onChange: (v: boolean) => void;
  /** 是否渲染（默认 true；仅在已出图待导出时由父组件控制显示） */
  visible?: boolean;
}

/**
 * AC1 镜像自拍自查（PRD AC1 / 任务 #35，务实方案）。
 *
 * 实现口径（任务台账 #35 决策，类比 T3 自检）：
 * - 不做 CV 自动识别（镜像照无可靠 EXIF 标记，启发式易误判伤体验）；
 * - 改为「拍摄引导文案（CameraGuide 警示）+ 导出前用户自查勾选」；
 * - 勾选前导出/保存按钮禁用，强制用户确认「照片未开启镜像/翻转（左脸在左、右脸在右）」。
 *
 * 该组件仅做 UI 与状态透传，是否放行由父组件用 confirmed 闸门其 save/export 按钮。
 */
export default function MirrorCheck({ confirmed, onChange, visible = true }: Props) {
  if (!visible) return null;
  const toggle = () => onChange(!confirmed);
  return (
    <View className='mirror-check'>
      <View
        className={`mirror-check__box${confirmed ? ' mirror-check__box--on' : ''}`}
        onClick={toggle}
      >
        {confirmed ? '✓' : ''}
      </View>
      <View className='mirror-check__label' onClick={toggle}>
        ⚠️ 镜像自拍（左右颠倒）会导致审核失败。我确认此照片未开启镜像/翻转（左脸在左、右脸在右）。
      </View>
    </View>
  );
}
