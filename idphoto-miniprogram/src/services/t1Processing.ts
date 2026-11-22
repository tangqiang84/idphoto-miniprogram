import Taro from '@tarojs/taro';
import { requiredConsents, buildConsentRecord, segment, composite, compositeTransparent, check, applyBeauty, applyPatches,
  BG, getSpec, getPixelSize, tightBBox, alphaBBox, measureHeadMetrics, checkComposition,
  SUIT_REASON, getSuitTemplateStatus, compareFaceRegion, backendLabel, buildCloudFnAdapter, withTimeout, IMG_LOAD_TIMEOUT_MS, EXPORT_TIMEOUT_MS,
} from '.';
import { requestPoseKeypoints, prepareSuitImage } from './poseService';
import { prepareWorkCanvas } from './pipeline';
import { prepareModelForSegment } from './modelService';
import { inspectExportedFile } from './exportInspection';
import { assessPixels } from '../core/outputEvidence';
import { loadResearchTemplate } from './suitAssets';
import { parseCloudSuitClothing } from './cloudClothingService';
import { measureCloudSuitFace } from './cloudFaceService';
import { composeCollarSuit } from '../core/suitCollarCompose';
import { fitCloudCollar } from './collarFitService';
import { type SessionTask } from '../core/processingSession';

const SUIT_TEMPLATES = [
  { id: 'black', src: require('../assets/suits/suit_black.png') },
  { id: 'navy', src: require('../assets/suits/suit_navy.png') },
  { id: 'gray', src: require('../assets/suits/suit_gray.png') },
];
async function loadTemplatePixels(src: string, native: {width:number;height:number}, place?: { w:number; h:number }): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const anyTaro: any = Taro;
  const scale = place ? Math.min(1, Math.max(place.w / native.width, place.h / native.height)) : 1;
  const width = Math.max(1, Math.ceil(native.width * scale)), height = Math.max(1, Math.ceil(native.height * scale));
  const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width, height });
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
  ctx.drawImage(img, 0, 0, width, height);
  const d = ctx.getImageData(0, 0, width, height);
  return { data: d.data, w: width, h: height };
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
    const suitMinKb = data.suitApplied && (tool === 'T1' || tool === 'T3') && p.dpi < 600
      ? getSpec(p.specId)?.minKb : undefined;
    const qualities = tool === 'T5' && p.kbLimit ? [0.95,0.9,0.85,0.8,0.7,0.6,0.5,0.4]
      : suitMinKb ? [0.95, 0.97, 1] : [0.95];
    let exported: any; let file: any;
    for (const quality of qualities) {
      exported = await task.call(() => withTimeout(Taro.canvasToTempFilePath({ canvas: out, x: 0, y: 0,
        width: target.width, height: target.height, destWidth: target.width, destHeight: target.height, fileType, quality }), EXPORT_TIMEOUT_MS, 'export:timeout'));
      file = await task.call(() => withTimeout(new Promise((resolve, reject) => {
        Taro.getFileSystemManager().getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
      }), EXPORT_TIMEOUT_MS, 'fileinfo:timeout'));
      if (suitMinKb && file.size < suitMinKb * 1024) continue;
      if (!p.kbLimit || file.size <= p.kbLimit * 1024) break;
    }
    const artifact = await task.call(() => inspectExportedFile(exported.tempFilePath, target, fileType));
    const size = { width: artifact.width, height: artifact.height };
    let report = check(p.specId, { widthPx: size.width, heightPx: size.height, dpi: p.dpi,
      fileKb: artifact.fileKb, bg: p.bg, headHeightRatio: data.headRatio ?? undefined });
    if (tool === 'T5') report = { ...report, checks: [
      { key: 'dimension', label: '尺寸', pass: size.width === target.width && size.height === target.height },
      { key: 'dpi', label: '像素档位', pass: true }, { key: 'bg', label: '保留原图底色', pass: true },
      { key: 'filesize', label: '文件大小', pass: !p.kbLimit || artifact.fileBytes <= p.kbLimit * 1024 },
    ] } as any;
    const colorRisk = tool === 'T2' && report.checks.some((c: any) => c.key === 'bg' && !c.pass);
    if (tool === 'T2') report = { ...report, checks: report.checks.map((c: any) => c.key === 'bg' ? { ...c, level: 'advisory' } : c) };
    const failed = report.checks.filter((c: any) => c.level !== 'advisory' && !c.pass);
    const finalReport = { ...report, pass: failed.length === 0, suggestions: failed.map((c: any) => c.detail || c.label) };
    const effective = { width: p.cropWindow!.w, height: p.cropWindow!.h };
    const processing = { width: data.plan.sw, height: data.plan.sh };
    const pixelEvidence = { source: { width: p.source!.width, height: p.source!.height }, effective,
      work: { width: data.w, height: data.h }, processingCrop: processing,
      segmentationInput: tool === 'T5' ? null : { width: data.w, height: data.h },
      target, ...assessPixels(effective, target, processing) };
    return { preview: exported.tempFilePath, fileType: artifact.fileType, dpiMetadata: artifact.dpiMetadata, fileBytes: artifact.fileBytes, pixelEvidence, colorRisk, isFinal: mode === 'final', result: finalReport, suitApplied: data.suitApplied,
      suitReason: data.suitReason, suitEvidence: data.suitEvidence, backend: data.backend, mattingEvidence: data.mattingEvidence, degraded: data.degraded, headRatio: data.headRatio,
      width: size.width, height: size.height, fileKb: Number(artifact.fileKb.toFixed(2)), dpi: p.dpi };
  }
  const checkSuit = (params: any) => getSuitTemplateStatus(params.suit.templateId, params.specId);
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
    const templateStatus = p.suit.enabled ? checkSuit(p) : null;
    if (templateStatus && !templateStatus.ok) throw { code: templateStatus.code, message: templateStatus.message, traceId: task.traceId };
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
      const cloudPermission = { traceId: task.traceId, check() { task.check(); if (!buildConsentRecord(tool, p.consents, 'cloud').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意上云增强', traceId: task.traceId }; } };
      const adapter = buildCloudFnAdapter({ authorization: cloudPermission });
      const model = await task.call(() => prepareModelForSegment({ check: () => task.check() }));
      if (model.reasonCode && model.reasonCode !== 'MODEL_DISABLED') console.warn('[model-fallback]', { code: model.reasonCode, traceId: task.traceId });
      const seg: any = await task.call(() => segment({ rgba, width: w, height: h, bgSamples: prepared.bgSamples,
        session: model.session, spec: model.spec, modelInfo: model, check: () => task.check(),
        cloud: { adapter: { ...adapter, call: (request) => task.call(() => adapter.call(request)) } },
        consents: p.consents, tool, forceCloud: !!image.forceCloud && p.consents.includes('faceCloudEnhance'),
        audit: (meta) => console.log('[audit]', { ...meta, traceId: task.traceId }) }));
      let alpha: any = seg.alpha instanceof Float32Array ? Float32Array.from(seg.alpha) : Uint8ClampedArray.from(seg.alpha);
      let suitAlphaLimit: Float32Array | null = null;
      const wantSuit = p.suit.enabled; const granted = p.consents;
      const templateIndex = SUIT_TEMPLATES.findIndex((tpl) => tpl.id === p.suit.templateId);
      let exportRgba: Uint8ClampedArray = rgba;
      let suitAppliedNow = false;
      // P1：换装被跳过的原因（非目标构图 / 引擎拒绝）——如实上状态行，不静默
      let suitSkipReason = '';
      let suitEvidence: any = null;
      if (wantSuit && granted.includes('suitSwap')) {
        task.step('suit');
        
        
        // #69：tightBBox 收紧（alphaBBox 的 min/max 会被云端 alpha 噪声前景撑爆，
        // 撑爆的 bbox 把换装定位带偏 → 盖脸/变形）
        const bbox = tightBBox(alpha, w, h) || alphaBBox(alpha, w, h);
        if (bbox) {
          const suitCloudPermission = { traceId: task.traceId, check() { cloudPermission.check(); if (!buildConsentRecord(tool, granted, 'suit').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意换装', traceId: task.traceId }; } };
          const suitInput = buildConsentRecord(tool, granted, 'pose').ready ? prepareSuitImage(prepared.canvas, w, h) : {imageB64:null,width:w,height:h};
          const jpegB64 = suitInput.imageB64;
          let headRes: any = await task.call(() => measureHeadMetrics(rgba, w, h, bbox));
          const requiresMouthLandmarks = templateStatus!.template.usage === 'research-only';
          // 已检出多人时直接保留拒绝结果，不用第二次检测挑出其中一人。
          if (!(headRes.faceCount > 1) && jpegB64 && (requiresMouthLandmarks ||
              !(headRes.ok && headRes.source === 'landmarks' && headRes.metrics?.quality === 'good' && headRes.faceCount === 1))) {
            headRes = await task.call(() => measureCloudSuitFace(jpegB64, suitInput.width, suitInput.height, suitCloudPermission, {width:w,height:h}));
          }
          // P1（#73/#74）：几何改由 suitFitV2 求解 —— 实测信号（L1 pose / L2 face）+ 规格物理标尺，
          // 不再用 v1 的「0.30×bbox.h 估算 + 行宽突变」猜测链（四轮失败的结构性根因）。
          const faceSig = headRes.ok && headRes.metrics ? {
            chinY: headRes.metrics.chinY,
            crownY: headRes.metrics.crownY,
            headH: headRes.headLengthPx,
            faceCenterX: headRes.metrics.faceCenterX,
            source: headRes.source === 'landmarks' ? 'landmarks' : 'estimate',
            quality: headRes.metrics.quality, rect: headRes.faceRect, faceCount: headRes.faceCount,
          } : null;
          // 领口模型以嘴角推算颏部起点，裁剪仍使用原有下巴坐标。
          const collarFace = faceSig?.rect && headRes.provider === 'mediapipe-face-landmarker-cpu' && headRes.facePoints?.length === 478
            ? {...faceSig, chinY: Math.max(faceSig.rect.y + .78 * faceSig.rect.h,
                Math.min(faceSig.rect.y + faceSig.rect.h,
                  (headRes.facePoints[61].y + headRes.facePoints[291].y) / 2 + .21 * faceSig.rect.h))}
            : requiresMouthLandmarks ? null : faceSig;
          let poseSig: any = null;
          let poseReason: string | null = null;
          if (jpegB64) {
            const pr = await task.call(() => requestPoseKeypoints({
              imageB64: jpegB64, width: suitInput.width, height: suitInput.height,
              region: { x: 0, y: 0, w, h }, canvasW: w, canvasH: h,
            }, { traceId: task.traceId, check() { cloudPermission.check(); if (!buildConsentRecord(tool, granted, 'suit').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意换装', traceId: task.traceId }; } }));
            if (pr.ok && pr.pose) poseSig = pr.pose;
            else poseReason = pr.reason;
          } else {
            poseReason = buildConsentRecord(tool, granted, 'pose').ready ? 'posekey:encode_failed' : 'posekey:consent_required';
          }
          console.log('[audit]', {
            stage: 'pose_signal', traceId: task.traceId, ok: !!poseSig, reason: poseReason,
            model: poseSig?.model === 'baidu-body-analysis' ? poseSig.model : null,
            latencyMs: poseSig ? poseSig.latencyMs : null,
          });

          const viewport = { x: prepared.plan.sx, y: prepared.plan.sy, w: prepared.plan.sw, h: prepared.plan.sh };
          const signals = { spec, canvasW: w, canvasH: h, face: collarFace ? faceSig : null, pose: poseSig, bbox, viewport, source: image };
          const comp = checkComposition(signals);
          const fit = comp.ok
            ? {ok:true,source:'pose',measuredShoulders:true,shoulderAngleDeg:comp.shoulderAngleDeg,reason:null,audit:{alignment:'visible-neck-opening'}} as any
            : { ok: false, reason: comp.reason || SUIT_REASON.UNSUPPORTED, message: comp.message, audit: {}, source: comp.source, measuredShoulders: comp.measuredShoulders, shoulderAngleDeg: comp.shoulderAngleDeg } as any;
          suitEvidence = { source: fit.source || 'none', measuredShoulders: fit.ok && fit.measuredShoulders === true,
            shoulderAngleDeg: fit.ok && fit.measuredShoulders ? fit.shoulderAngleDeg : null,
            templateId: p.suit.templateId, templateUsage: templateStatus!.template.usage || 'approved',
            geometrySource: templateStatus!.template.geometrySource || 'reviewed',
            qualityReview: 'not-reviewed', faceProvider: headRes.provider || 'wechat-device', faceRectSource: headRes.rectSource || 'device-detector', poseReason, reason: fit.reason || null };
          if (fit.ok) {
            const template = templateStatus!.template;
            const templatePermission = { check() { task.check(); if (!buildConsentRecord(tool, granted, 'suit').ready) throw { code: 'CONSENT_REQUIRED', message: '未同意换装', traceId: task.traceId }; } };
            const clothingPermission = { traceId: task.traceId, check() { cloudPermission.check(); templatePermission.check(); } };
            const clothing = await task.call(() => parseCloudSuitClothing(jpegB64, suitInput.width, suitInput.height, clothingPermission, {width:w,height:h}));
            const src = template.usage === 'research-only'
              ? await task.call(() => loadResearchTemplate(template, templatePermission))
              : SUIT_TEMPLATES[templateIndex]?.src;
            if (!src) throw { code: 'SUIT_ASSET_INVALID', message: '未找到换装模板', traceId: task.traceId };
            const collar = await task.call(() => fitCloudCollar(suitInput, {width:w,height:h,alpha}, collarFace, template, clothingPermission));
            const geometry=collar.geometry;
            const tpl = await task.call(() => loadTemplatePixels(src as any, template.native, {w:geometry.templateWidth*geometry.scaleX,h:geometry.templateHeight*geometry.scale}));
            const parsed = composeCollarSuit({rgba, alpha, width: w, height: h, clothing: clothing.clothing, background: clothing.background, backgroundMode: clothing.backgroundMode,
              faceRect: faceSig!.rect, facePoints: headRes.facePoints || null, tpl: tpl.data, tplW: tpl.w, tplH: tpl.h,
              geometry});
            const candidate = parsed.rgba;
            const diff = compareFaceRegion(rgba, candidate, faceSig!.rect, { width: w, height: h });
            let protectedChanged = 0;
            for (let i = 0; i < alpha.length; i++) if (parsed.protectedMask[i]) for(let c=0;c<4;c++) if(rgba[i*4+c]!==candidate[i*4+c]) protectedChanged++;
            let faceAlphaChanged = 0;
            for (let i = 0; i < alpha.length; i++) if (parsed.protectedMask[i] && parsed.alpha[i] !== alpha[i]) faceAlphaChanged++;
            const safe = diff.checked && protectedChanged === 0 && faceAlphaChanged === 0;
            suitEvidence = { ...suitEvidence, source:'collar', geometrySource:'visible-neck-opening-cpu', faceDiff: diff, faceDiffScope:'rectangle-diagnostic-only', protectedChanged, faceAlphaChanged,
              clothing: clothing.evidence, collar:collar.evidence, protectedRegion:'landmarks-convex-hull-and-forehead', removedClothingPixels: parsed.removedClothingPixels,
              faceProtection: headRes.facePoints ? 'landmarks-convex-hull-and-forehead' : 'face-rectangle', pixelProtectionPassed: safe };
            if (safe) { exportRgba = candidate; alpha = parsed.alpha; suitAlphaLimit = parsed.alphaLimit; suitAppliedNow = true; }
            else { suitSkipReason = '脸部像素核验未通过，已拒绝换装（suit:face_changed）'; suitEvidence.reason = 'suit:face_changed'; }
            console.log('[audit]', { stage: 'suit_collar_fit', traceId: task.traceId, ok: safe, ...fit.audit,
              measuredShoulders: suitEvidence.measuredShoulders, shoulderAngleDeg: suitEvidence.shoulderAngleDeg,
              faceChecked: diff.checked, protectedChanged, qualityReview: 'not-reviewed' });
          } else {
            suitSkipReason = fit.message + '（' + fit.reason + '）';
            console.log('[audit]', { stage: 'suit_collar_fit', traceId: task.traceId, ok: false, reason: fit.reason, source: fit.source });
          }

        } else {
          suitSkipReason = '未检测到有效人像区域，已拒绝换装（suit:unsupported_composition）';
          suitEvidence = { source: 'none', measuredShoulders: false, shoulderAngleDeg: null, reason: 'suit:unsupported_composition', qualityReview: 'not-reviewed' };
        }
      }

      const metrics = prepared.srcMetrics;
      const win = p.cropWindow;
      const headRatio = metrics && win ? Math.max(0, Math.min(win.h, metrics.chinY - win.y) - Math.max(0, metrics.crownY - win.y)) / win.h : null;
      data = { key, w, h, alpha, suitAlphaLimit, exportRgba, plan: prepared.plan, headRatio,
        suitApplied: suitAppliedNow, suitEvidence, suitReason: suitSkipReason, backend: seg.evidence?.label || backendLabel(seg.backend), mattingEvidence: seg.evidence, degraded: !!seg.degraded };
    }
    if (strokes) {
      const { sx, sy, sw, sh } = data.plan;
      const mapped = strokes.map((stroke) => ({ ...stroke,
        radius: stroke.radius * Math.min(sw, sh) / Math.min(data.w, data.h),
        points: stroke.points.map((point) => ({ x: (sx + point.x * sw) / data.w, y: (sy + point.y * sh) / data.h })),
      }));
      data = { ...data, alpha: applyPatches(data.alpha, data.w, data.h, mapped) };
      if (data.suitAlphaLimit) for (let i = 0; i < data.alpha.length; i++) data.alpha[i] = Math.min(data.alpha[i], data.suitAlphaLimit[i]);
    }
    task.step(mode === 'final' ? 'export' : 'preview');
    const result = await render(task, data, mode);
    task.check(); cache = data;
    return result;
  }
  return { suggest, process, checkSuit, release() { cache = null; } };
}
