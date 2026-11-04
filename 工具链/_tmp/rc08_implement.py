"""RC-08实现修改留存：不应重复运行。"""
from pathlib import Path
r=Path(__file__).resolve().parents[2]
p=r/'idphoto-miniprogram/src/services/t1Processing.ts';s=p.read_text().replace("import { prepareWorkCanvas } from './pipeline';","import { prepareWorkCanvas } from './pipeline';\nimport { inspectExportedFile } from './exportInspection';\nimport { assessPixels } from '../core/outputEvidence';")
a=s.index('    const size = await task.call');b=s.index('    let report = check',a)
s=s[:a]+"    const artifact = await task.call(() => inspectExportedFile(exported.tempFilePath, target, fileType));\n    const size = { width: artifact.width, height: artifact.height };\n"+s[b:]
s=s.replace('fileKb: Math.round(file.size / 1024), bg:', 'fileKb: artifact.fileKb, bg:')
s=s.replace("    return { preview: exported.tempFilePath, fileType, colorRisk", "    const effective = { width: p.cropWindow!.w, height: p.cropWindow!.h };\n    const processing = { width: data.plan.sw, height: data.plan.sh };\n    const pixelEvidence = { source: { width: p.source!.width, height: p.source!.height }, effective,\n      work: { width: data.w, height: data.h }, processingCrop: processing,\n      segmentationInput: tool === 'T5' ? null : { width: data.w, height: data.h },\n      target, ...assessPixels(effective, target, processing) };\n    return { preview: exported.tempFilePath, fileType: artifact.fileType, dpiMetadata: artifact.dpiMetadata, fileBytes: artifact.fileBytes, pixelEvidence, colorRisk")
s=s.replace('fileKb: Math.round(file.size / 1024), dpi: p.dpi','fileKb: Number(artifact.fileKb.toFixed(2)), dpi: p.dpi');p.write_text(s)
p=r/'idphoto-miniprogram/src/components/DpiStep/index.tsx';s=p.read_text().replace("import { planOutput } from '../../core/compose';","import { assessPixels } from '../../core/outputEvidence';")
s=s.replace('  effectiveH?: number;','  effectiveH?: number;\n  customTarget?: { width: number; height: number } | null;\n  processingW?: number;\n  processingH?: number;')
s=s.replace('effectiveH, stepLabel }: Props)', 'effectiveH, stepLabel, customTarget, processingW, processingH }: Props)')
s=s.replace('const target = dpi === DPI_HD ? t600 : t300;', 'const target = customTarget || (dpi === DPI_HD ? t600 : t300);')
a=s.index('  // T1优先');b=s.index('\n  return (',a)
s=s[:a]+'''  // 工作图只说明处理分辨率，不能证明原图裁剪区域含有足够细节。
  const evidence = assessPixels({ width: effectiveW, height: effectiveH }, target, { width: processingW, height: processingH });
  const verdict = evidence.sourceEnough === null
    ? { ok: false, text: '未取得原图有效裁剪像素，无法确认清晰度；工作图尺寸不能替代原图证据' }
    : !evidence.sourceEnough
      ? { ok: false, text: `原图有效裁剪像素不足（${Math.round(effectiveW!)}×${Math.round(effectiveH!)}），输出将被放大，不能补回细节` }
      : evidence.processingEnough === false
        ? { ok: false, text: '原图像素足够，但当前处理分辨率不足，最终输出仍需放大' }
        : { ok: true, text: '原图有效裁剪像素满足目标；像素充足不代表算法处理质量已达标' };
''' + s[b:]
s=s.replace("{d === DPI_HD ? '600dpi 印刷级' : '300dpi 标准'}", "{d === DPI_HD ? '600dpi 像素档' : '300dpi 像素档'}")
s=s.replace('{!noSpec ? (','{!noSpec && !customTarget ? (')
s=s.replace('<Text className=\'step-dpi__sub\'>两档均免费 · 无水印 · 导出前最后一步</Text>',"<Text className='step-dpi__sub'>免费 · 无水印；dpi为按物理规格换算的像素档位，不承诺文件dpi元数据。</Text>")
s=s.replace('{t300 && t600 ? (','{!customTarget && t300 && t600 ? (')
s=s.replace("<Text className='step-dpi__spec'>目标规格：{specName}</Text>","<Text className='step-dpi__spec'>{customTarget ? `自定义固定像素：${customTarget.width}×${customTarget.height}px（不随dpi翻倍）` : `目标规格：${specName}`}</Text>")
# 过期参数仅兼容类型，不再用于清晰度判断。
s=s.replace('srcW, srcH, workW, workH, noSpec,','noSpec,')
p.write_text(s)
p=r/'idphoto-miniprogram/src/components/PhotoTool/index.tsx';s=p.read_text();s=s.replace("{p.customTarget ? <Text>自定义输出固定为{target.width}×{target.height}px，不随dpi翻倍，不写入dpi元数据。</Text> : <DpiStep",'<DpiStep customTarget={p.customTarget}')
s=s.replace('effectiveH={p.cropWindow?.h} />}','effectiveH={p.cropWindow?.h} processingW={state.preview?.pixelEvidence?.processingCrop?.width} processingH={state.preview?.pixelEvidence?.processingCrop?.height} />')
s=s.replace("<Text className='tag'>免费 · 无水印；dpi表示输出像素档位，不承诺写入文件元数据。</Text>","<Text className='tag'>免费 · 无水印；dpi表示输出像素档位，不承诺写入文件元数据。</Text>\n        {state.finalResult.pixelEvidence?.sourceEnough === false || state.finalResult.pixelEvidence?.processingEnough === false ? <Text className='color-risk'>当前输出包含放大，增加像素不能补回原图或处理过程损失的细节。</Text> : null}")
p.write_text(s)
p=r/'idphoto-miniprogram/src/pages/tool-idphoto/index.tsx';s=p.read_text().replace('effectiveH={p.cropWindow?.h} />','effectiveH={p.cropWindow?.h} processingW={state.preview?.pixelEvidence?.processingCrop?.width} processingH={state.preview?.pixelEvidence?.processingCrop?.height} />');s=s.replace("<Text className='tag'>免费 · 无水印；dpi表示输出像素档位，不承诺写入文件元数据。</Text>","<Text className='tag'>免费 · 无水印；dpi表示输出像素档位，不承诺写入文件元数据。</Text>\n        {state.finalResult.pixelEvidence?.sourceEnough === false || state.finalResult.pixelEvidence?.processingEnough === false ? <Text className='color-risk'>当前输出包含放大，增加像素不能补回原图或处理过程损失的细节。</Text> : null}");p.write_text(s)
p=r/'idphoto-miniprogram/src/core/compliance.js';s=p.read_text().replace("label: '分辨率',","label: '输出像素档位',").replace('detail: `实测 ${dpi}dpi，要求 ≥${DPI_STD}dpi`,','detail: `按 ${dpi}dpi 档位换算目标像素，不代表已读取或写入文件dpi元数据`,');p.write_text(s)
p=r/'idphoto-miniprogram/src/services/renderService.ts';s=p.read_text();s="import { inspectExportedFile } from './exportInspection';\n"+s
a=s.index('  const fs = Taro.getFileSystemManager();');s=s[:a]+'''  const actual = await inspectExportedFile(exported.tempFilePath, { width: outW, height: outH }, transparent ? 'png' : (p.fileType || 'jpg'));
  return { preview: exported.tempFilePath, fileKb: actual.fileKb, outW: actual.width, outH: actual.height };
}
''';p.write_text(s)
