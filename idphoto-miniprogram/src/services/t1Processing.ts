import Taro from '@tarojs/taro';
import { requiredConsents, buildConsentRecord, segment, composite, compositeTransparent, check, applyBeauty, applyPatches,
  BG, getSpec, getPixelSize, tightBBox, alphaBBox, measureHeadMetrics, checkComposition,
  fitSuitV2, SUIT_REASON, suitCompose, backendLabel, buildCloudFnAdapter, withTimeout, IMG_LOAD_TIMEOUT_MS, EXPORT_TIMEOUT_MS,
} from '.';
import { requestPoseKeypoints, encodeCanvasToJpegB64 } from './poseService';
import { prepareWorkCanvas } from './pipeline';
import { type SessionTask } from '../core/processingSession';

const SUIT_TEMPLATES = [
  { id: 'black', src: require('../assets/suits/suit_black.png') },
  { id: 'navy', src: require('../assets/suits/suit_navy.png') },
  { id: 'gray', src: require('../assets/suits/suit_gray.png') },
];
async function loadTemplatePixels(src: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const anyTaro: any = Taro;
  const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: 400, height: 400 });
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  // #70：图片加载加超时硬闸门（真机上 onload/onerror 可能双不触发 → 永久转圈）
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e: any) => reject(e || new Error('模板加载失败'));
      img.src = src;
    }),
    IMG_LOAD_TIMEOUT_MS,
    '模板加载超时',
  );
  ctx.drawImage(img, 0, 0, 400, 400);
  const d = ctx.getImageData(0, 0, 400, 400);
  return { data: d.data, w: 400, h: 400 };
}


export function createT1Processing(tool = 'T1') {
  let cache: any = null;
  const identity = (task: SessionTask) => JSON.stringify([task.sourceId, ...Object.entries(task.params).filter(([k]) => !['bg', 'dpi'].includes(k))]);
  const requireConsent = (task: SessionTask) => {
    task.check();
    if (!buildConsentRecord(tool, task.params.consents).ready) throw new Error('AC5: consent required');
  };
  async function suggest(task: SessionTask) {
    requireConsent(task);
    const p = task.params; const image = p.source!;
    const prepared = await task.call(() => prepareWorkCanvas({ path: image.path, srcW: image.width, srcH: image.height,
      spec: getSpec(p.specId), dpi: p.dpi, target: getPixelSize(p.specId, p.dpi)!, cropWindow: null }));
    const crop = prepared.crop;
    return crop ? { x: crop.sx, y: crop.sy, w: crop.sw, h: crop.sh } : null;
  }
  async function render(task: SessionTask, data: any, mode: string) {
    const p = task.params; const target = p.customTarget || getPixelSize(p.specId, p.dpi)!;
    const anyTaro: any = Taro;
    const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: data.w, height: data.h });
    const cx = cv.getContext('2d');
    const pixels = cx.getImageData(0, 0, data.w, data.h);
    pixels.data.set(tool === 'T5' ? data.exportRgba : tool === 'T2' || p.bg === null ? compositeTransparent(data.exportRgba, data.alpha, data.w, data.h) : composite(data.exportRgba, data.alpha, data.w, data.h, BG[p.bg] || p.bg));
    cx.putImageData(pixels, 0, 0);
    const out = anyTaro.createOffscreenCanvas({ type: '2d', width: target.width, height: target.height });
    out.getContext('2d').drawImage(cv, data.plan.sx, data.plan.sy, data.plan.sw, data.plan.sh, 0, 0, target.width, target.height);
    if (tool === 'T2' && p.bg !== null) {
      // 以最终照片坐标生成底色，避免工作画布余量把渐变端点裁掉。
      const context = out.getContext('2d');
      const foreground = context.getImageData(0, 0, target.width, target.height);
      const alpha = new Float32Array(target.width * target.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = foreground.data[i * 4 + 3] / 255;
      foreground.data.set(composite(foreground.data, alpha, target.width, target.height, BG[p.bg] || p.bg));
      context.putImageData(foreground, 0, 0);
    }
    const fileType = tool === 'T2' && p.bg === null ? 'png' : 'jpg';
    let exported: any; let file: any;
    for (const quality of (tool === 'T5' && p.kbLimit ? [0.95,0.9,0.85,0.8,0.7,0.6,0.5,0.4] : [0.95])) {
      exported = await task.call(() => withTimeout(Taro.canvasToTempFilePath({ canvas: out, x: 0, y: 0,
        width: target.width, height: target.height, destWidth: target.width, destHeight: target.height, fileType, quality }), EXPORT_TIMEOUT_MS, 'export:timeout'));
      file = await task.call(() => withTimeout(new Promise((resolve, reject) => {
        Taro.getFileSystemManager().getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
      }), EXPORT_TIMEOUT_MS, 'fileinfo:timeout'));
      if (!p.kbLimit || file.size <= p.kbLimit * 1024) break;
    }
    const size = await task.call(() => Taro.getImageInfo({ src: exported.tempFilePath }));
    if (!Number.isFinite(file.size) || file.size <= 0 || !(size.width > 0) || !(size.height > 0)) throw new Error('export:invalid_file');
    let report = check(p.specId, { widthPx: size.width, heightPx: size.height, dpi: p.dpi,
      fileKb: Math.round(file.size / 1024), bg: p.bg, headHeightRatio: data.headRatio ?? undefined });
    if (tool === 'T5') report = { ...report, checks: [
      { key: 'dimension', label: '尺寸', pass: size.width === target.width && size.height === target.height },
      { key: 'dpi', label: '像素档位', pass: true }, { key: 'bg', label: '保留原图底色', pass: true },
      { key: 'filesize', label: '文件大小', pass: !p.kbLimit || file.size <= p.kbLimit * 1024 },
    ] } as any;
    const colorRisk = tool === 'T2' && report.checks.some((c: any) => c.key === 'bg' && !c.pass);
    if (tool === 'T2') report = { ...report, checks: report.checks.map((c: any) => c.key === 'bg' ? { ...c, level: 'advisory' } : c) };
    return { preview: exported.tempFilePath, fileType, colorRisk, isFinal: mode === 'final', result: report, suitApplied: data.suitApplied,
      suitReason: data.suitReason, backend: data.backend, degraded: data.degraded, headRatio: data.headRatio,
      width: size.width, height: size.height, fileKb: Math.round(file.size / 1024), dpi: p.dpi };
  }
  async function process(task: SessionTask, mode: string, strokes?: any[]) {
    requireConsent(task);
    const p = task.params; const image = p.source!;
    if (tool === 'T5') {
      const target = p.customTarget || getPixelSize(p.specId, p.dpi)!;
      const canvas = (Taro as any).createOffscreenCanvas({ type: '2d', width: target.width, height: target.height });
      const img = canvas.createImage();
      await task.call(() => withTimeout(new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('IMAGE_LOAD')); img.src = image.path; }), IMG_LOAD_TIMEOUT_MS, 'image:timeout'));
      const win = p.cropWindow!;
      canvas.getContext('2d').drawImage(img, win.x, win.y, win.w, win.h, 0, 0, target.width, target.height);
      const prepared = { w: target.width, h: target.height, rgba: canvas.getContext('2d').getImageData(0, 0, target.width, target.height).data,
        plan: { sx: 0, sy: 0, sw: target.width, sh: target.height } };
      task.step('export');
      return render(task, { ...prepared, exportRgba: prepared.rgba, alpha: null, headRatio: null, suitApplied: false }, mode);
    }
    const key = identity(task);
    let data = cache && cache.key === key ? cache : null;
    if (!data) {
      const spec = getSpec(p.specId)!;
      // 工作像素按最高开放档位准备，预览只生成临时查看图，不充当最终成品。
      const prepared = await task.call(() => prepareWorkCanvas({ path: image.path, srcW: image.width, srcH: image.height,
        spec, dpi: 600, target: getPixelSize(p.specId, 600)!, cropWindow: p.cropWindow }));
      const { w, h } = prepared;
      const rgba = new Uint8ClampedArray(prepared.rgba);
      task.step('beauty');
      if (p.beauty.enabled) applyBeauty(rgba, w, h, p.beauty);
      task.step('matting');
      const cloudPermission = { check() { task.check(); if (!buildConsentRecord(tool, p.consents, 'cloud').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意上云增强', traceId: task.traceId }; } };
      const adapter = buildCloudFnAdapter({ authorization: cloudPermission });
      const seg: any = await task.call(() => segment({ rgba, width: w, height: h, bgSamples: prepared.bgSamples,
        cloud: { adapter: { ...adapter, call: (request) => task.call(() => adapter.call(request)) } },
        consents: p.consents, tool, forceCloud: !!image.forceCloud && p.consents.includes('faceCloudEnhance'),
        audit: (meta) => console.log('[audit]', meta) }));
      const alpha = seg.alpha instanceof Float32Array ? Float32Array.from(seg.alpha) : Uint8ClampedArray.from(seg.alpha);
      const wantSuit = p.suit.enabled; const granted = p.consents;
      const templateIndex = SUIT_TEMPLATES.findIndex((tpl) => tpl.id === p.suit.templateId);
      let exportRgba: Uint8ClampedArray = rgba;
      let suitAppliedNow = false;
      // P1：换装被跳过的原因（非目标构图 / 引擎拒绝）——如实上状态行，不静默
      let suitSkipReason = '';
      if (wantSuit && granted.includes('suitSwap')) {
        task.step('suit');
        
        
        // #69：tightBBox 收紧（alphaBBox 的 min/max 会被云端 alpha 噪声前景撑爆，
        // 撑爆的 bbox 把换装定位带偏 → 盖脸/变形）
        const bbox = tightBBox(alpha, w, h) || alphaBBox(alpha, w, h);
        if (bbox) {
          const headRes = await task.call(() => measureHeadMetrics(rgba, w, h, bbox));
          // P1（#73/#74）：几何改由 suitFitV2 求解 —— 实测信号（L1 pose / L2 face）+ 规格物理标尺，
          // 不再用 v1 的「0.30×bbox.h 估算 + 行宽突变」猜测链（四轮失败的结构性根因）。
          const faceSig = headRes.ok && headRes.metrics ? {
            chinY: headRes.metrics.chinY,
            crownY: headRes.metrics.crownY,
            headH: headRes.headLengthPx,
            faceCenterX: headRes.metrics.faceCenterX,
            source: headRes.source === 'landmarks' ? 'landmarks' : 'estimate',
          } : null;
          let poseSig: any = null;
          let poseReason: string | null = null;
          const jpegB64 = buildConsentRecord(tool, granted, 'pose').ready ? encodeCanvasToJpegB64(prepared.canvas) : null;
          if (jpegB64) {
            const pr = await task.call(() => requestPoseKeypoints({
              imageB64: jpegB64, width: w, height: h,
              region: { x: 0, y: 0, w, h }, canvasW: w, canvasH: h,
            }, { check() { cloudPermission.check(); if (!buildConsentRecord(tool, granted, 'suit').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意换装', traceId: task.traceId }; } }));
            if (pr.ok && pr.pose) poseSig = pr.pose;
            else poseReason = pr.reason;
          } else {
            poseReason = 'posekey:encode_failed';
          }
          console.log('[audit]', {
            stage: 'pose_signal', ok: !!poseSig, reason: poseReason,
            model: poseSig ? poseSig.model : null, latencyMs: poseSig ? poseSig.latencyMs : null,
          });

          const comp = checkComposition({ face: faceSig, pose: poseSig, bbox });
          const fit = comp.ok
            ? fitSuitV2({ spec: spec as any, canvasW: w, canvasH: h, face: faceSig, pose: poseSig, bbox })
            : { ok: false, reason: SUIT_REASON.UNSUPPORTED, message: comp.message, audit: {} } as any;
          if (fit.ok) {
            const tpl = await task.call(() => loadTemplatePixels(SUIT_TEMPLATES[templateIndex].src as any));
            exportRgba = suitCompose(rgba, alpha, w, h, tpl.data, tpl.w, tpl.h, fit.place, fit.rotateDeg);
            suitAppliedNow = true;
            console.log('[audit]', Object.assign({ stage: 'suit_fit_v2', ok: true }, fit.audit));
          } else {
            // R1/契约 7：非目标构图或引擎拒绝 → 不换装，如实提示（不猜着摆、不静默出图）
            suitSkipReason = fit.message + '（' + fit.reason + '）';
            console.log('[audit]', { stage: 'suit_fit_v2', ok: false, reason: fit.reason, audit: fit.audit });
          }
        }
      }

      const metrics = prepared.srcMetrics;
      const win = p.cropWindow;
      const headRatio = metrics && win ? Math.max(0, Math.min(win.h, metrics.chinY - win.y) - Math.max(0, metrics.crownY - win.y)) / win.h : null;
      data = { key, w, h, alpha, exportRgba, plan: prepared.plan, headRatio,
        suitApplied: suitAppliedNow, suitReason: suitSkipReason, backend: backendLabel(seg.backend), degraded: !!seg.degraded };
    }
    if (strokes) {
      const { sx, sy, sw, sh } = data.plan;
      const mapped = strokes.map((stroke) => ({ ...stroke,
        radius: stroke.radius * Math.min(sw, sh) / Math.min(data.w, data.h),
        points: stroke.points.map((point) => ({ x: (sx + point.x * sw) / data.w, y: (sy + point.y * sh) / data.h })),
      }));
      data = { ...data, alpha: applyPatches(data.alpha, data.w, data.h, mapped) };
    }
    task.step(mode === 'final' ? 'export' : 'preview');
    const result = await render(task, data, mode);
    task.check(); cache = data;
    return result;
  }
  return { suggest, process };
}
