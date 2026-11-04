from pathlib import Path
p=Path('idphoto-miniprogram/src/pages/tool-print/index.tsx');s=p.read_text();s="import { printGeometry } from '../../core/printGeometry';\nimport { inspectExportedFile } from '../../services/exportInspection';\n"+s
s=s.replace('    setBusy(true);','    setBusy(true);\n    setPreview(\'\');\n    setResult(null);')
s=s.replace("if (!cancelled) setMsg('生成失败：' + String((e && e.message) || e));", "if (!cancelled) { const traceId = `print-${Date.now()}`; console.warn('[T6]', { code: e?.code || 'PRINT_EXPORT_FAILED', traceId }); setMsg(`生成失败，请重试（PRINT_EXPORT_FAILED，${traceId}）`); }")
s=s.replace('    const layout = planLayout(pid, sid);', '    const layout = printGeometry(pid, sid);')
s=s.replace("    if (!layout) throw new Error('排版计算失败');", "    if (!layout || !layout.valid) throw { code: 'PRINT_GEOMETRY', message: '排版几何校验失败' };")
a=s.index('    const sheet = layout.sheetPx;');b=s.index('    const image = cv.createImage();',a)
s=s[:a]+'''    const canvasW = layout.width, canvasH = layout.height;
    const cv: any = anyTaro.createOffscreenCanvas({ type: '2d', width: canvasW, height: canvasH });
    const ctx: any = cv.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvasW, canvasH);
    const fwp = layout.placements[0].width, fhp = layout.placements[0].height;

'''+s[b:]
s=s.replace('const tr = fwp / fhp;', 'const tr = layout.photoRotated ? fhp / fwp : fwp / fhp;')
s=s.replace('      ctx.drawImage(image, sx, sy, sw, sh, dx, dy, fwp, fhp);', '''      if (layout.photoRotated) {
        ctx.save();
        ctx.translate(dx + fwp, dy);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, fhp, fwp);
        ctx.restore();
      } else ctx.drawImage(image, sx, sy, sw, sh, dx, dy, fwp, fhp);''')
a=s.index('    if (!paper.tileable) {');b=s.index('    const exported:',a)
s=s[:a]+'''    for (const placement of layout.placements) drawOne(placement.x, placement.y);

'''+s[b:]
a=s.index('    const fs = Taro.getFileSystemManager();');b=s.index('\n    return {',a)
s=s[:a]+'''    const artifact = await inspectExportedFile(exported.tempFilePath, { width: canvasW, height: canvasH }, 'jpg');
    const fileKb = Number(artifact.fileKb.toFixed(2));
'''+s[b:]
s=s.replace('    if (!preview) return;', '    if (!preview || busy || !pick.mirrorConfirmed) return;')
s=s.replace("{result.dpi}dpi · {result.fileKb}KB", "{result.dpi}dpi 像素档 · {result.fileKb}KB")
s=s.replace('说明：导出为拼版 JPG', '说明：dpi为相纸尺寸换算像素，不承诺文件dpi元数据。导出为拼版 JPG')
s=s.replace('裁剪参考线仅供自裁定位，不会印到成品。','开启时参考线会写入拼版图，仅供自裁定位。')
p.write_text(s)
p=Path('工具链/page_flow_probe.js');s=p.read_text().replace("      if (request.endsWith('/services/t1Processing'))", "      if (request === './exportInspection' || request.endsWith('/services/exportInspection')) return load(path.resolve(ROOT, 'idphoto-miniprogram/src/services/exportInspection.ts'));\n      if (request.endsWith('/services/t1Processing'))");p.write_text(s)
p=Path('工具链/tests/processing_session_page.test.js');s=p.read_text().replace('height: input.destHeight });','height: input.destHeight, type: input.fileType });').replace("error.code, 'FLOW_HARD_CHECK'", "error.code, 'EXPORT_DIMENSION'");p.write_text(s)
