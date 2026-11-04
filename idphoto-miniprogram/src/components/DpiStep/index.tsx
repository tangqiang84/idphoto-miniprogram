import { View, Text } from '@tarojs/components';
import { assessPixels } from '../../core/outputEvidence';
import { getSpec, getPixelSize, DPI_STD, DPI_HD } from '../../core/specLibrary';
import './index.scss';

// 档位只表示目标像素；有效裁剪像素与处理像素分别判断，不冒充文件DPI元数据。

interface Props {
  /** 规格 id（用于算 300/600dpi 目标像素） */
  specId: string;
  /** 规格显示名 */
  specName: string;
  /** 当前档位 */
  dpi: number;
  onChange: (dpi: number) => void;
  /** 原图像素（裁剪前）——用于评估 */
  srcW?: number;
  srcH?: number;
  /** 历史工作画布参数（仅兼容旧调用，不作为原图像素证据） */
  workW?: number;
  workH?: number;
  /** 未知规格的兼容提示；当前T1/T2/T3/T5均必须选择目标 */
  noSpec?: boolean;
  stepLabel?: string;
  effectiveW?: number;
  effectiveH?: number;
  customTarget?: { width: number; height: number } | null;
  processingW?: number;
  processingH?: number;
}

export default function DpiStep({ specId, specName, dpi, onChange, noSpec, effectiveW, effectiveH, stepLabel, customTarget, processingW, processingH }: Props) {
  const spec = noSpec ? null : getSpec(specId);
  const t300 = spec ? getPixelSize(spec, DPI_STD) : null;
  const t600 = spec ? getPixelSize(spec, DPI_HD) : null;
  const target = customTarget || (dpi === DPI_HD ? t600 : t300);

  // 工作图只说明处理分辨率，不能证明原图裁剪区域含有足够细节。
  const evidence = assessPixels({ width: effectiveW, height: effectiveH }, target, { width: processingW, height: processingH });
  const verdict = evidence.sourceEnough === null
    ? { ok: false, text: '未取得原图有效裁剪像素，无法确认清晰度；工作图尺寸不能替代原图证据' }
    : !evidence.sourceEnough
      ? { ok: false, text: `原图有效裁剪像素不足（${Math.round(effectiveW!)}×${Math.round(effectiveH!)}），输出将被放大，不能补回细节` }
      : evidence.processingEnough === false
        ? { ok: false, text: '原图像素足够，但当前处理分辨率不足，最终输出仍需放大' }
        : { ok: true, text: '原图有效裁剪像素满足目标；像素充足不代表算法处理质量已达标' };

  return (
    <View className='step-dpi' data-step='dpi'>
      <View className='step-dpi__head'>
        <Text className='step-dpi__title'>{stepLabel || '④ 输出档位'}</Text>
        <Text className='step-dpi__sub'>免费 · 无水印；dpi为按物理规格换算的像素档位，不承诺文件dpi元数据。</Text>
      </View>

      {!noSpec && !customTarget ? (
      <View className='step-dpi__row'>
        {[DPI_STD, DPI_HD].map((d) => {
          const on = dpi === d;
          const px = d === DPI_HD ? t600 : t300;
          return (
            <View
              key={d}
              className={`step-dpi__chip${on ? ' is-on' : ''}`}
              onClick={() => onChange(d)}
            >
              <Text className='step-dpi__chip-main'>{d === DPI_HD ? '600dpi 像素档' : '300dpi 像素档'}</Text>
              <Text className='step-dpi__chip-sub'>{px ? `${px.width}×${px.height}px` : ''}</Text>
            </View>
          );
        })}
      </View>
      ) : null}

      <View className='step-dpi__info'>
        {noSpec ? (
          <Text className='step-dpi__verdict is-warn'>
            ⚠ 未取得目标规格，无法评估输出像素，请先选择规格
          </Text>
        ) : (
          <Text className='step-dpi__spec'>{customTarget ? `自定义固定像素：${customTarget.width}×${customTarget.height}px（不随dpi翻倍）` : `目标规格：${specName}`}</Text>
        )}
        {!customTarget && t300 && t600 ? (
          <Text className='step-dpi__req'>
            300dpi 需 {t300.width}×{t300.height}px · 600dpi 需 {t600.width}×{t600.height}px
          </Text>
        ) : null}
        {verdict ? (
          <Text className={`step-dpi__verdict ${verdict.ok ? 'is-ok' : 'is-warn'}`}>
            {verdict.ok ? '✓ ' : '⚠ '}{verdict.text}
          </Text>
        ) : null}
        {verdict && !verdict.ok ? (
          <Text className='step-dpi__advice'>
            建议：① 重传更高分辨率原图 ② 改用 300dpi（报名系统通常只收 300dpi）
          </Text>
        ) : null}
      </View>
    </View>
  );
}
