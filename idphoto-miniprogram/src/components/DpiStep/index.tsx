import { View, Text } from '@tarojs/components';
import { planOutput } from '../../core/compose';
import { getSpec, getPixelSize, DPI_STD, DPI_HD } from '../../core/specLibrary';
import './index.scss';

/**
 * 输出档位步骤屏（P2.7 / `s_dpi`，T1/T2/T3/T5 共用）
 *
 * 【为什么独立成一步】v0.4 之前 300/600dpi 只作为规格页/导出页的一个内嵌选项，
 * 用户看不到"这个档位需要多少像素、我的原图够不够"，于是常常选完 600dpi 拿到一张糊图。
 * 本步骤屏按「当前规格 + 原图/裁剪后真实像素」**动态评估**并明示风险（RC-4）。
 *
 * 【口径】像素是否够，用 core/compose.js 的 planOutput 判定（与实际出图路径同一套）：
 *   · upscale=true  → 成品是放大来的（清晰度下降）
 *   · srcTooSmall=true → 原图分辨率不足，再放大也补不回细节
 * 两档**均免费无水印**（owner 2026-10-23 决策），本组件只做提示，不设付费门槛。
 */

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
  /** 裁剪后工作画布像素（可选；有则优先用它评估，更贴近真实出图） */
  workW?: number;
  workH?: number;
  /** 未选规格模式（T2 允许「保持原图尺寸」）：显示提示，不做像素评估 */
  noSpec?: boolean;
}

export default function DpiStep({ specId, specName, dpi, onChange, srcW, srcH, workW, workH, noSpec }: Props) {
  const spec = noSpec ? null : getSpec(specId);
  const t300 = spec ? getPixelSize(spec, DPI_STD) : null;
  const t600 = spec ? getPixelSize(spec, DPI_HD) : null;
  const target = dpi === DPI_HD ? t600 : t300;

  // 评估：优先用裁剪后画布（贴近真实出图），没有则退回原图
  let verdict: { ok: boolean; text: string } | null = null;
  if (target && workW && workH && srcW && srcH) {
    const plan = planOutput(workW, workH, target.width, target.height);
    if (plan) {
      if (plan.srcTooSmall) {
        verdict = { ok: false, text: `原图分辨率不足（${workW}×${workH}），放大到 ${dpi}dpi 不会更清晰` };
      } else if (plan.upscale) {
        verdict = { ok: false, text: `像素不足，放大会降低清晰度（输出为放大结果）` };
      } else {
        verdict = { ok: true, text: '当前像素满足该档位，成品为实拍像素' };
      }
    }
  }

  return (
    <View className='step-dpi' data-step='dpi'>
      <View className='step-dpi__head'>
        <Text className='step-dpi__title'>④ 输出档位</Text>
        <Text className='step-dpi__sub'>两档均免费 · 无水印 · 导出前最后一步</Text>
      </View>

      {!noSpec ? (
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
              <Text className='step-dpi__chip-main'>{d === DPI_HD ? '600dpi 印刷级' : '300dpi 标准'}</Text>
              <Text className='step-dpi__chip-sub'>{px ? `${px.width}×${px.height}px` : ''}</Text>
            </View>
          );
        })}
      </View>
      ) : null}

      <View className='step-dpi__info'>
        {noSpec ? (
          <Text className='step-dpi__verdict is-warn'>
            ⚠ 未选择目标规格 → 输出保持原图尺寸，不适用 dpi 档位（选择规格后即可按档位输出）
          </Text>
        ) : (
          <Text className='step-dpi__spec'>目标规格：{specName}</Text>
        )}
        {t300 && t600 ? (
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
