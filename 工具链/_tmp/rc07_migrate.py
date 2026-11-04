"""RC-07共享页面迁移；保留旧页面供审计，拒绝重复。"""
from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[2]
out=root/'docs/验证记录/RC-07-implementation'
out.mkdir(exist_ok=False)
for name in ['tool-bg','tool-suit','tool-spec']:
 shutil.copy2(root/f'idphoto-miniprogram/src/pages/{name}/index.tsx',out/f'{name}-before.tsx')
p=root/'idphoto-miniprogram/src/core/processingSession.js';s=p.read_text().replace("const { centerCropWindow", "const { resolveBackground } = require('./color');\nconst { centerCropWindow")
s=s.replace("const allowed = ['source'", "const allowed = ['customTarget', 'kbLimit', 'source'")
s=s.replace("|| !BG[next.bg]", "|| (options.tool === 'T2' ? resolveBackground(next.bg).type === 'invalid' : !BG[next.bg])\n        || (next.customTarget != null && (options.tool !== 'T5' || !['width','height'].every(k => Number.isInteger(next.customTarget[k]) && next.customTarget[k] >= 1 && next.customTarget[k] <= 5000)))\n        || (next.kbLimit != null && (!Number.isFinite(next.kbLimit) || next.kbLimit < 0 || next.kbLimit > 20000))")
s=s.replace("changed.includes('source') || changed.includes('specId')", "changed.includes('source') || changed.includes('specId') || changed.includes('customTarget')")
s=s.replace("const target = getPixelSize(next.specId, 300);", "const target = next.customTarget || getPixelSize(next.specId, 300);")
p.write_text(s)
p=root/'idphoto-miniprogram/src/core/processingSession.d.ts';s=p.read_text().replace('  bg: string;', '  bg: any;\n  customTarget?: { width: number; height: number } | null;\n  kbLimit?: number;').replace('  timeoutMs?: number;', '  timeoutMs?: number;\n  tool?: string;');p.write_text(s)
p=root/'idphoto-miniprogram/src/core/t1Workflow.js';s=p.read_text().replace("['specId', 'cropWindow', 'cropConfirmed']", "['specId', 'customTarget', 'cropWindow', 'cropConfirmed']")
s=s.replace("!session.getState().params.consents.includes('faceLocal')", "(tool !== 'T5' && !session.getState().params.consents.includes('faceLocal'))")
s=s.replace("change.consents && !change.consents.includes('faceLocal')", "tool !== 'T5' && change.consents && !change.consents.includes('faceLocal')")
s=s.replace("else if (changed.includes('dpi'))", "else if (changed.includes('kbLimit')) { screen = 'dpi'; }\n      else if (changed.includes('dpi'))")
s=s.replace("const baseKey = () => key(['dpi']);", "const baseKey = () => key(tool === 'T5' ? ['dpi', 'kbLimit'] : ['dpi']);")
s=s.replace("const beautyKey = () => key(['bg', 'suit', 'dpi', 'consents']);", "const beautyKey = () => key(['bg', 'suit', 'dpi', 'consents', 'kbLimit']);")
p.write_text(s)
p=root/'idphoto-miniprogram/src/hooks/useT1Workflow.ts';s=p.read_text().replace('export function useT1Workflow() {', "export function useT1Workflow(tool = 'T1') {").replace('createProcessingSession();','createProcessingSession({ tool });').replace("createConsentSession('T1')",'createConsentSession(tool)').replace('createT1Workflow(session, createT1Processing())', 'createT1Workflow(session, createT1Processing(tool), { tool })');p.write_text(s)
p=root/'idphoto-miniprogram/src/services/t1Processing.ts';s=p.read_text().replace('segment, composite, check', 'segment, composite, compositeTransparent, check')
s=s.replace('export function createT1Processing() {', "export function createT1Processing(tool = 'T1') {")
s=s.replace("buildConsentRecord('T1',", 'buildConsentRecord(tool,').replace("tool: 'T1'", 'tool')
s=s.replace('const target = getPixelSize(p.specId, p.dpi)!;', 'const target = p.customTarget || getPixelSize(p.specId, p.dpi)!;')
s=s.replace('pixels.data.set(composite(data.exportRgba, data.alpha, data.w, data.h, BG[p.bg]));', "pixels.data.set(tool === 'T5' ? data.exportRgba : p.bg === null ? compositeTransparent(data.exportRgba, data.alpha, data.w, data.h) : composite(data.exportRgba, data.alpha, data.w, data.h, BG[p.bg] || p.bg));")
start=s.index('    const exported: any = await task.call')
end=s.index('    const size = await task.call',start)
s=s[:start]+'''    const fileType = tool === 'T2' && p.bg === null ? 'png' : 'jpg';
    let exported: any; let file: any;
    for (const quality of (tool === 'T5' && p.kbLimit ? [0.95,0.9,0.85,0.8,0.7,0.6,0.5,0.4] : [0.95])) {
      exported = await task.call(() => withTimeout(Taro.canvasToTempFilePath({ canvas: out, x: 0, y: 0,
        width: target.width, height: target.height, destWidth: target.width, destHeight: target.height, fileType, quality }), EXPORT_TIMEOUT_MS, 'export:timeout'));
      file = await task.call(() => withTimeout(new Promise((resolve, reject) => {
        Taro.getFileSystemManager().getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
      }), EXPORT_TIMEOUT_MS, 'fileinfo:timeout'));
      if (!p.kbLimit || file.size <= p.kbLimit * 1024) break;
    }
''' +s[end:]
s=s.replace('const report = check(', 'let report = check(')
at=s.index('    return { preview: exported.tempFilePath')
s=s[:at]+'''    if (tool === 'T5') report = { ...report, checks: [
      { key: 'dimension', label: '尺寸', pass: size.width === target.width && size.height === target.height },
      { key: 'dpi', label: '像素档位', pass: true }, { key: 'bg', label: '保留原图底色', pass: true },
      { key: 'filesize', label: '文件大小', pass: !p.kbLimit || file.size <= p.kbLimit * 1024 },
    ] } as any;
    const colorRisk = tool === 'T2' && report.checks.some((c: any) => c.key === 'bg' && !c.pass);
    if (tool === 'T2') report = { ...report, checks: report.checks.map((c: any) => c.key === 'bg' ? { ...c, level: 'advisory' } : c) };
''' +s[at:]
s=s.replace('preview: exported.tempFilePath, isFinal:', 'preview: exported.tempFilePath, fileType, colorRisk, isFinal:')
at=s.index('    const key = identity(task);')
s=s[:at]+'''    if (tool === 'T5') {
      const target = p.customTarget || getPixelSize(p.specId, p.dpi)!;
      const prepared = await task.call(() => prepareWorkCanvas({ path: image.path, srcW: image.width, srcH: image.height,
        spec: null, dpi: p.dpi, target, cropWindow: p.cropWindow }));
      task.step('export');
      return render(task, { ...prepared, exportRgba: prepared.rgba, alpha: null, headRatio: null, suitApplied: false }, mode);
    }
''' +s[at:]
p.write_text(s)
