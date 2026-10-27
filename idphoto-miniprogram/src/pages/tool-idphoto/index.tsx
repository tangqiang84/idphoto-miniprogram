import { View, Text, Button, Image, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  requiredConsents, buildConsentRecord,
  segment, composite, check, applyPatches,
  alphaBBox, suitPlacement, suitCompose,
  buildCloudFnAdapter,
  measureHeadMetrics, ratioWithinWindow,
  planOutput, planWindowOutput, planDetectImage,
  planHeadCrop, targetHeadRatio,
  collectEdgeSamples,
  BG, getSpec, getPixelSize, listSpecs, specLabel,
  DPI_STD, DPI_HD,
} from '../../services';
import { useImagePicker } from '../../hooks/useImagePicker';
import { applyBeauty } from '../../services';
import BeautyControl, { type BeautyState } from '../../components/BeautyControl';
import AlphaPatch from '../../components/AlphaPatch';

// T1 一键证件照：完整链路（真实功能，非占位）
// 选图 → 端侧抠图 →（置信不足且已授权则走 CloudBase 云函数增强）→ 换底
// → 裁剪到规格尺寸 → 导出 → 合规预审 → 保存相册
//
// 隐私合规：授权默认【不勾选】，未集齐授权不启动处理（对应 PRD AC5）。
//
// 【2026-10-23 owner 决策】MVP 不设付费档，300/600dpi 两档全部免费：
//   - 个人主体无法开通微信支付（问题台账 #14）→ 付费档无落地路径 → 暂不上付费档
//   - 600dpi 印刷级同样免费开放，不再作为「付费才给」的能力
//   - 官方报名系统只校验像素+KB+格式，从不校验 dpi 元数据；600dpi 的用途是印刷/冲印
const TOOL = 'T1';

type BgKey = 'white' | 'blue' | 'blueLight' | 'red';

// AI 换装（PRD D 章 / T1-11/12，任务 #43）：复用 T3 端侧贴图合成能力。
// 自绘模板（AI 自绘，自有版权，PRD Q3 合规）：与 T3 同一套透明 PNG。
const SUIT_TEMPLATES = [
  { id: 'black', name: '黑西装', src: require('../../assets/suits/suit_black.png') },
  { id: 'navy', name: '深蓝西装', src: require('../../assets/suits/suit_navy.png') },
  { id: 'gray', name: '灰西装', src: require('../../assets/suits/suit_gray.png') },
];
// 换装单独授权项（个保法敏感个人信息单独同意 / AC5）：取 T3 同一份 CONSENT 定义，避免文案漂移
const SUIT_CONSENT =
  requiredConsents('T3').find((c: any) => c.id === 'suitSwap') ||
  { id: 'suitSwap', label: 'AI换装', desc: '合成职业装，仅换装不改五官，需单独授权' };

// 读模板 PNG → RGBA 像素（离屏 canvas；与 tool-suit 同一实现）
async function loadTemplatePixels(src: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const anyTaro: any = Taro;
  const canvas = anyTaro.createOffscreenCanvas({ type: '2d', width: 400, height: 400 });
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e: any) => reject(e || new Error('模板加载失败'));
    img.src = src;
  });
  ctx.drawImage(img, 0, 0, 400, 400);
  const d = ctx.getImageData(0, 0, 400, 400);
  return { data: d.data, w: 400, h: 400 };
}

export default function ToolIdPhoto() {
  const consentItems = requiredConsents(TOOL);
  const [granted, setGranted] = useState<string[]>([]);
  const rec = buildConsentRecord(TOOL, granted);
  const picker = useImagePicker((img) => {
    setLastPick(img);
    run(img.path, img.width, img.height);
  });

  const specs = listSpecs();
  const [specIndex, setSpecIndex] = useState(0);
  const [dpi, setDpi] = useState(DPI_STD);
  const [bg, setBg] = useState<BgKey>('white');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<any>(null);
  // 受限美颜（PRD E 章 / AC2，任务 #38）：默认关闭，用户显式开启并调节（轻度）
  const [beauty, setBeauty] = useState<BeautyState>({
    enabled: false, smooth: 0.35, whiten: 0.3, brighten: 0.2,
  });
  // 最近一次取图（用于美颜「重新生成」时复用，无需重新选图）
  const [lastPick, setLastPick] = useState<{ path: string; width: number; height: number } | null>(null);
  // 头部占比测量结果（PRD B3 / T1-16，任务 #4）：null = 未检测到人脸
  const [headInfo, setHeadInfo] = useState<any>(null);
  // 输出构图提示（如「原图分辨率不足」/「已达处理分辨率上限」）
  const [planNote, setPlanNote] = useState('');
  // 智能裁切信息（任务 #24 / PRD B2）：
  //   auto=false → 未检出人脸，已降级为「按宽高比居中裁剪」（与 #24 前行为一致）
  //   degraded     → 已按占比反解裁剪，但原片构图不足，如实提示（owner 决策：不阻断导出）
  const [cropInfo, setCropInfo] = useState<any>(null);
  // 手动修补（PRD B1 / T1-17，任务 #42）：修补面板开关 + 修补所需的工作画布数据
  //   patchBase = { rgba, alpha, w, h, plan, target, bg, workPreviewPath }
  const [patching, setPatching] = useState(false);
  const [patchBase, setPatchBase] = useState<any>(null);
  // AI 换装（PRD D 章 / T1-11/12，任务 #43）：
  //   suitPanelOpen = 面板展开；suitTplIndex = 模板选择；suitOn = 用户意图（应用换装）；
  //   suitApplied = 当前预览是否已换装（决定是否强制五官自检闸门）；selfChecked = D3/AC6 自检确认。
  const [suitPanelOpen, setSuitPanelOpen] = useState(false);
  const [suitTplIndex, setSuitTplIndex] = useState(0);
  const [suitOn, setSuitOn] = useState(false);
  const [suitApplied, setSuitApplied] = useState(false);
  const [selfChecked, setSelfChecked] = useState(false);

  const toggleConsent = (id: string) => {
    setGranted((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // 放宽 Taro 类型（微信 canvas 2d API 在部分基础库类型不全，统一用 any 访问）
  const anyTaro: any = Taro;

  async function run(path: string, srcW: number, srcH: number, opts?: { suitOn?: boolean }) {
    if (!rec.ready) {
      Taro.showToast({ title: '请先勾选所需授权', icon: 'none' });
      return;
    }
    // 换装意图：显式传参优先（避免 setState 异步 → 同一函数内读到旧值，见下方第 136 行同类注释）
    const wantSuit = opts && typeof opts.suitOn === 'boolean' ? opts.suitOn : suitOn;
    setBusy(true);
    setMsg('读取图片…');
    setResult(null);
    setHeadInfo(null);
    setPlanNote('');
    setCropInfo(null);
    setSelfChecked(false); // 每次重新生成都使旧自检失效（AC6：未自检不得导出）
    try {
      if (typeof anyTaro.createOffscreenCanvas !== 'function') {
        throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
      }

      // 取图已剥离到 useImagePicker（相册 picker.pickAlbum / 拍摄 CameraGuide，PRD A1 引导框）。
      const spec = getSpec(specs[specIndex].id);
      const target = getPixelSize(spec!, dpi)!;

      // 把一张图片画进离屏 canvas 并取回 RGBA 像素（微信 canvas 通用取像素姿势）
      const loadRgba = async (cw: number, ch: number, draw: (ctx: any, img: any) => void) => {
        const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: cw, height: ch });
        const cx = cv.getContext('2d');
        const im = cv.createImage();
        await new Promise<void>((resolve, reject) => {
          im.onload = () => resolve();
          im.onerror = (e: any) => reject(e || new Error('图片加载失败'));
          im.src = path;
        });
        draw(cx, im);
        const id = cx.getImageData(0, 0, cw, ch);
        return { canvas: cv, ctx: cx, imageData: id, rgba: id.data };
      };

      // 2. 人脸检测（任务 #24 / PRD B2 智能裁切的前置）
      //    检测在【检测用图】上做（长边 ≤ DETECT_EDGE=1200）：人脸关键点需要足够像素细节，
      //    同时避免为检测而绘制全尺寸大图（RGBA 内存 = 长边²×4）。
      //    此处拿到的头顶/下巴/面部中心都是检测用图坐标，需按 1/scale 换算回原图坐标。
      setMsg('识别人脸…');
      const det = planDetectImage(srcW, srcH);
      if (!det) throw new Error('图片尺寸读取失败，请换一张照片');
      const detImg = await loadRgba(det.width, det.height, (cx, im) => {
        cx.drawImage(im, 0, 0, det.width, det.height);
      });
      const fm = await measureHeadMetrics(detImg.rgba, det.width, det.height, null);
      // 换算回原图坐标（检测用图是原图的等比缩放，比例不变）
      const srcMetrics = fm.ok && fm.metrics
        ? {
          ...fm.metrics,
          crownY: fm.metrics.crownY / det.scale,
          chinY: fm.metrics.chinY / det.scale,
          faceCenterX: typeof fm.metrics.faceCenterX === 'number'
            ? fm.metrics.faceCenterX / det.scale
            : undefined,
        }
        : null;

      // 3. 反解裁剪框（按规格头占比区间中值，core/headCrop.js）
      //    检测不可用时 srcMetrics 为 null → 降级为「居中裁剪」，并在页面提示。
      let crop: any = null;
      let plan: any;
      if (srcMetrics) {
        crop = planHeadCrop({
          workW: srcW,
          workH: srcH,
          targetW: target.width,
          targetH: target.height,
          crownY: srcMetrics.crownY,
          chinY: srcMetrics.chinY,
          faceCenterX: srcMetrics.faceCenterX,
          ratioMin: spec!.headHeightRatioMin,
          ratioMax: spec!.headHeightRatioMax,
        });
      }

      if (crop) {
        // 3.1 区域化工作画布：只把「要用到的那块」放大到足够像素，避免成品是放大糊图
        plan = planWindowOutput(srcW, srcH, target.width, target.height, {
          sx: crop.sx, sy: crop.sy, sw: crop.sw, sh: crop.sh,
        });
      }
      if (!plan) {
        // 降级路径：未检出人脸 / 反解失败 → 沿用「按目标宽高比居中裁剪」
        plan = planOutput(srcW, srcH, target.width, target.height);
      }
      if (!plan) throw new Error('图片尺寸读取失败，请换一张照片');

      const w = plan.workW;
      const h = plan.workH;
      setPlanNote(plan.reason || '');
      setCropInfo(crop
        ? {
          auto: true,
          ratioTarget: crop.ratioTarget,
          ratioAchieved: crop.ratioAchieved,
          degraded: crop.degraded,
          degradeReason: crop.degradeReason,
          notes: crop.notes || [],
        }
        : { auto: false, notes: ['未检出人脸，已按画面居中裁剪；建议正对镜头、面部清晰的照片'] });

      // 4. 取工作画布像素
      //    自动裁剪路径：画「裁剪窗 + 余量」这一块（planWindowOutput 已算好源图区域）
      //    降级路径：画整图（planOutput 的工作画布 = 整图等比缩放）
      const work = await loadRgba(w, h, (cx, im) => {
        if (plan.regionX != null) {
          cx.drawImage(im, plan.regionX, plan.regionY, plan.regionW, plan.regionH, 0, 0, w, h);
        } else {
          cx.drawImage(im, 0, 0, w, h);
        }
      });
      const rgba = work.rgba;

      // 4.0 受限美颜（PRD E 章 / AC2，任务 #38）：在抠图前对原图做轻度磨皮/美白/亮眼。
      //     仅当用户开启美颜时执行；合规模式由 core/beauty.js 内的 assertCompliance 兜底硬拦截禁止项。
      //     异常（理论上不会触发，因 UI 仅传允许项）静默跳过，绝不阻断主流程。
      if (beauty.enabled) {
        try {
          applyBeauty(rgba, w, h, {
            smooth: beauty.smooth,
            whiten: beauty.whiten,
            brighten: beauty.brighten,
          });
        } catch (e) {
          console.warn('[T1] 美颜跳过（合规拦截或异常）:', (e && e.message) || e);
        }
      }

      // 4.1 背景色采样集（任务 #24）
      // 经典抠图基线的背景色由「画布四边环带」估计。自动裁剪时工作画布只含
      // 「裁剪窗 + 余量」，四边可能压在头发/肩膀上 → 背景色估计失准。
      // 故在【检测用图】（覆盖整张原图）上采一次注入，行为与整图抠图一致。
      const bgSamples = crop ? collectEdgeSamples(detImg.rgba, det.width, det.height, 2) : undefined;

      // 5. 抠图：端侧优先，置信不足自动走 CloudBase 云函数增强（需 faceCloudEnhance 授权）
      setMsg('抠图处理中…');
      const seg: any = await segment({
        rgba,
        width: w,
        height: h,
        bgSamples,
        cloud: { adapter: buildCloudFnAdapter() },
        consents: granted,
        audit: (meta: any) => console.log('[audit]', meta),
        tool: TOOL,
      });

      // 6. 换底合成：暂存工作画布的 RGBA 与 alpha，供「手动修补」重合成（PRD B1 / T1-17）
      setMsg('合成底色…');
      const workRgbaCopy = new Uint8ClampedArray(rgba);
      const baseAlphaCopy = new Uint8ClampedArray(seg.alpha);

      // 6.1 AI 换装（可选，PRD D 章 / T1-11，任务 #43）：端侧贴图合成（复用 core/suit.js）。
      //   D2：仅覆盖肩颈前景区（alpha>0.5 且模板不透明），不触碰脸部像素；D3/AC6 强制自检在页面层。
      //   仅在「应用换装」且已勾选 suitSwap 单独授权时执行；否则使用原图 RGBA（零回归）。
      let exportRgba: Uint8ClampedArray = workRgbaCopy;
      let suitAppliedNow = false;
      if (wantSuit && granted.includes('suitSwap')) {
        setMsg('合成职业装…');
        const bbox = alphaBBox(seg.alpha, w, h);
        if (bbox) {
          const headRes = await measureHeadMetrics(workRgbaCopy, w, h, bbox);
          const headH = headRes.ok && headRes.headLengthPx ? headRes.headLengthPx : bbox.h * 0.30;
          const tpl = await loadTemplatePixels(SUIT_TEMPLATES[suitTplIndex].src as any);
          const place = suitPlacement(bbox, headH);
          exportRgba = suitCompose(workRgbaCopy, seg.alpha, w, h, tpl.data, tpl.w, tpl.h, place);
          suitAppliedNow = true;
        }
      }
      setSuitApplied(suitAppliedNow);

      // 7. 头部占比测量（与 alpha 无关，复用第 2 步人脸度量，不重复检测）
      // 口径：在【裁剪窗口】坐标系中测量 —— 头长 ÷ 成品图高，与审核员在成品图上量的口径一致。
      // 坐标换算：检测用图坐标 → 原图坐标（÷det.scale）→ 工作图坐标（×plan.scale）。
      const sx = plan.sx, sy = plan.sy, sw = plan.sw, sh = plan.sh;
      setMsg('测量头部占比…');
      let headRatio: number | null = null;
      let headExtra: any = null;
      if (srcMetrics) {
        const wm = {
          ...srcMetrics,
          crownY: srcMetrics.crownY * plan.scale,
          chinY: srcMetrics.chinY * plan.scale,
        };
        const r = ratioWithinWindow(wm, { x: sx, y: sy, width: sw, height: sh });
        if (r) {
          headRatio = r.ratio;
          headExtra = { source: srcMetrics.source, quality: srcMetrics.quality, notes: srcMetrics.notes || [] };
          if (r.clamped) headExtra.notes = [...headExtra.notes, '头顶或下巴被裁切，占比按成品图可见部分计算'];
        }
      }
      // 未检出人脸时降级为「未检测」，其余 4 项照常预审（不因一项缺失而阻断整张图）
      setHeadInfo(headRatio != null ? { ratio: headRatio, ...headExtra } : null);

      // 8. 合成 + 裁剪导出（提取为 composeAndExport，手动修补重合成复用同一套）
      setMsg('合成与导出…');
      const exp = await composeAndExport(exportRgba, seg.alpha, w, h, plan, BG[bg], target);
      setPreview(exp.preview);
      // 8.1 生成工作画布修补底图（合成底色后的整图），供手动修补面板显示边缘
      const wp = await saveWorkPreview(exportRgba, seg.alpha, w, h, BG[bg]);
      setPatchBase({ rgba: exportRgba, alpha: baseAlphaCopy, w, h, plan, target, bg, workPreviewPath: wp });

      // 9. 合规预审
      const fs = Taro.getFileSystemManager();
      const fileInfo: any = await new Promise((resolve, reject) => {
        fs.getFileInfo({ filePath: exp.preview, success: resolve, fail: reject });
      });
      const fileKb = Math.round(fileInfo.size / 1024);
      const cr = check(specs[specIndex].id, {
        widthPx: target.width,
        heightPx: target.height,
        dpi,
        fileKb,
        bg,
        // 头部占比：仅在成功测量时传入（未检测则跳过该项，其余 4 项照常判定）
        headHeightRatio: headRatio != null ? headRatio : undefined,
      });
      setResult(cr);
      setMsg(`完成（${seg.backend}${seg.degraded ? '，已降级端侧' : ''}）`);
    } catch (e: any) {
      const m = String((e && e.message) || e);
      if (m.startsWith('AC5')) {
        setMsg('该图端侧质量不足，需「上云增强」授权才能处理');
        Taro.showToast({ title: '请先勾选上云增强授权', icon: 'none' });
      } else {
        setMsg('处理失败：' + m);
      }
      console.error('[T1]', e);
    } finally {
      setBusy(false);
    }
  }

  // 合成 + 裁剪导出（与 run 共用：把工作画布 RGBA + alpha 合成底色、按裁剪窗缩放到目标规格并导出）
  // 返回 { preview, fileKb }。手动修补调用 regenerate 时复用本函数重合成。
  async function composeAndExport(workRgba: Uint8ClampedArray, alpha: Uint8ClampedArray | number[], w: number, h: number, plan: any, bgHex: string, target: { width: number; height: number }) {
    const composed = composite(workRgba, alpha, w, h, bgHex);
    const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const cx = cv.getContext('2d');
    const blank: any = cx.getImageData(0, 0, w, h);
    blank.data.set(composed);
    cx.putImageData(blank, 0, 0);

    const outCanvas = anyTaro.createOffscreenCanvas({ type: '2d', width: target.width, height: target.height });
    const octx = outCanvas.getContext('2d');
    octx.drawImage(cv, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, target.width, target.height);

    const exported: any = await Taro.canvasToTempFilePath({
      canvas: outCanvas,
      x: 0, y: 0, width: target.width, height: target.height,
      destWidth: target.width, destHeight: target.height,
      fileType: 'jpg', quality: 0.95,
    });
    const fs = Taro.getFileSystemManager();
    const fi: any = await new Promise((resolve, reject) => {
      fs.getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
    });
    return { preview: exported.tempFilePath, fileKb: Math.round(fi.size / 1024) };
  }

  // 生成工作画布修补底图（合成底色后的整图，PNG），供手动修补面板显示抠图边缘
  async function saveWorkPreview(workRgba: Uint8ClampedArray, alpha: Uint8ClampedArray | number[], w: number, h: number, bgHex: string) {
    const composed = composite(workRgba, alpha, w, h, bgHex);
    const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const cx = cv.getContext('2d');
    const blank: any = cx.getImageData(0, 0, w, h);
    blank.data.set(composed);
    cx.putImageData(blank, 0, 0);
    const exported: any = await Taro.canvasToTempFilePath({
      canvas: cv,
      x: 0, y: 0, width: w, height: h,
      destWidth: w, destHeight: h,
      fileType: 'png',
    });
    return exported.tempFilePath;
  }

  // 手动修补：对基线 alpha 应用用户笔画，重合成并刷新预览 + 合规预审
  async function regenerate(strokes: any[]) {
    if (!patchBase) return;
    try {
      setBusy(true);
      setMsg('应用修补并重合成…');
      const patched = applyPatches(patchBase.alpha, patchBase.w, patchBase.h, strokes);
      const exp = await composeAndExport(patchBase.rgba, patched, patchBase.w, patchBase.h, patchBase.plan, BG[patchBase.bg], patchBase.target);
      setPreview(exp.preview);
      const cr = check(specs[specIndex].id, {
        widthPx: patchBase.target.width,
        heightPx: patchBase.target.height,
        dpi,
        fileKb: exp.fileKb,
        bg: patchBase.bg,
        headHeightRatio: headInfo != null ? headInfo.ratio : undefined,
      });
      setResult(cr);
      setPatching(false);
      setMsg('修补完成');
    } catch (e: any) {
      setMsg('修补失败：' + String((e && e.message) || e));
      console.error('[T1] regenerate', e);
    } finally {
      setBusy(false);
    }
  }

  // 应用换装：需先勾选 suitSwap 单独授权；用最近一次取图重跑（避免重复选图）
  function applySuit() {
    if (!lastPick) { Taro.showToast({ title: '请先选择照片', icon: 'none' }); return; }
    if (!granted.includes('suitSwap')) { Taro.showToast({ title: '请先勾选「AI换装」单独授权', icon: 'none' }); return; }
    setSuitOn(true);
    run(lastPick.path, lastPick.width, lastPick.height, { suitOn: true });
  }
  function cancelSuit() {
    setSuitOn(false);
    setSuitApplied(false);
    if (lastPick) run(lastPick.path, lastPick.width, lastPick.height, { suitOn: false });
  }

  async function save() {
    if (!preview) return;
    // D3/AC6：换装后未完成五官自检不得导出
    if (suitApplied && !selfChecked) {
      Taro.showToast({ title: '请先完成五官自检', icon: 'none' });
      return;
    }
    try {
      await Taro.saveImageToPhotosAlbum({ filePath: preview });
      Taro.showToast({ title: '已保存到相册' });
    } catch (e) {
      Taro.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
    }
  }

  // PRD K1 入口①：从 T1 导出页「另存为排版版」进入 T6 冲印排版（承接已做好的证件照）
  // 说明：只传导出图路径（临时文件），T6 侧读不到时自动降级为「手动从相册选择」，不阻断。
  async function goPrintLayout() {
    if (!preview) return;
    try {
      await Taro.navigateTo({
        url: `/pages/tool-print/index?src=${encodeURIComponent(preview)}`,
      });
    } catch (e) {
      Taro.showToast({ title: '打开冲印排版失败，请从首页进入', icon: 'none' });
    }
  }

  const bgOptions: { key: BgKey; label: string; color: string }[] = [
    { key: 'white', label: '白底', color: BG.white },
    { key: 'blue', label: '标准深蓝', color: BG.blue },
    { key: 'blueLight', label: '浅蓝', color: BG.blueLight },
    { key: 'red', label: '红底', color: BG.red },
  ];

  return (
    <View className='page'>
      <Text className='page__title'>一键证件照</Text>

      {/* 授权（默认不勾选，未集齐不启动处理） */}
      <View className='consent'>
        <Text className='consent__h'>需授权（{granted.length}/{consentItems.length}）</Text>
        {consentItems.map((c: any) => {
          const on = granted.includes(c.id);
          return (
            <View
              key={c.id}
              className='consent__item'
              onClick={() => toggleConsent(c.id)}
              style={{
                border: on ? '1px solid #438EDB' : '1px solid #ddd',
                background: on ? '#eef5fd' : '#fff',
                padding: '8px',
                marginBottom: '6px',
                borderRadius: '6px',
              }}
            >
              <Text style={{ fontWeight: on ? 'bold' : 'normal' }}>
                {on ? '☑ ' : '☐ '}
                {c.label}
              </Text>
              <Text className='consent__desc'>{c.desc}</Text>
            </View>
          );
        })}
      </View>

      {/* 规格与底色 */}
      <View style={{ margin: '12px 0' }}>
        <Text>规格：</Text>
        <Picker
          mode='selector'
          range={specs.map((s: any) => specLabel(s.id, dpi))}
          value={specIndex}
          onChange={(e: any) => setSpecIndex(Number(e.detail.value))}
        >
          <View style={{ color: '#438EDB', padding: '4px 0' }}>{specs[specIndex].name} ▾</View>
        </Picker>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
          {specs[specIndex].source}
        </Text>
        {/* 输出档位（dpi）：300/600 两档全部免费（owner 2026-10-23 决策，不设付费档） */}
        <Text style={{ display: 'block', marginTop: '8px' }}>输出档位：</Text>
        <View style={{ display: 'flex', flexDirection: 'row', marginTop: '4px' }}>
          {[
            { dpi: DPI_STD, label: '标准 300dpi', hint: '网上报名通用' },
            { dpi: DPI_HD, label: '印刷 600dpi', hint: '冲印/大幅面' },
          ].map((o) => {
            const on = dpi === o.dpi;
            return (
              <View
                key={o.dpi}
                className={on ? 'dpi-opt dpi-opt--on' : 'dpi-opt'}
                onClick={() => setDpi(o.dpi)}
                style={{
                  padding: '6px 12px',
                  marginRight: '8px',
                  borderRadius: '6px',
                  border: on ? '2px solid #438EDB' : '1px solid #ccc',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '13px', color: on ? '#2b6cb0' : '#666' }}>{o.label}</Text>
              </View>
            );
          })}
        </View>
        <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
          两档均免费无水印。600dpi 像素翻倍、体积约为 300dpi 的 2~4 倍，报名系统通常只收 300dpi。
        </Text>
        {/* 规格速览芯片：直接点选 + 展示官方像素（2026-10-23 规格数值裁决后新增） */}
        <View className='spec-chips'>
          {specs.map((s: any, i: number) => {
            const px = getPixelSize(s.id, dpi)!;
            const on = specIndex === i;
            return (
              <View
                key={s.id}
                className='spec-chip'
                onClick={() => setSpecIndex(i)}
                style={{
                  padding: '5px 10px',
                  marginRight: '6px',
                  marginBottom: '6px',
                  borderRadius: '20px',
                  border: on ? '1px solid #438EDB' : '1px solid #ddd',
                  background: on ? '#eef5fd' : '#fff',
                }}
              >
                <Text style={{ fontSize: '12px', color: on ? '#2b6cb0' : '#666' }}>
                  {s.name} {px.width}×{px.height}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      <View style={{ display: 'flex', flexDirection: 'row', margin: '12px 0' }}>
        {bgOptions.map((o) => (
          <View
            key={o.key}
            onClick={() => setBg(o.key)}
            style={{
              padding: '8px 14px',
              marginRight: '8px',
              borderRadius: '6px',
              background: o.color,
              color: o.key === 'white' ? '#333' : '#fff',
              border: bg === o.key ? '2px solid #333' : '1px solid #ccc',
            }}
          >
            <Text>{o.label}</Text>
          </View>
        ))}
      </View>

      <Button className='btn-primary' loading={busy} onClick={picker.pickAlbum}>
        {busy ? '处理中…' : '从相册选择'}
      </Button>
      <Button className='btn-camera' onClick={picker.openCamera}>
        📷 拍摄（引导框）
      </Button>

      {msg ? <Text style={{ display: 'block', marginTop: '10px', color: '#666' }}>{msg}</Text> : null}

      {/* 智能裁切状态（任务 #24 / PRD B2）：按规格头占比自动定位裁剪框 */}
      {cropInfo ? (
        <View className='crop-info'>
          <Text style={{ fontSize: '12px', color: cropInfo.auto ? '#2b6cb0' : '#999' }}>
            {cropInfo.auto
              ? `智能裁切：已按目标头部占比 ${(cropInfo.ratioTarget * 100).toFixed(0)}% 自动构图`
              : '智能裁切：未检出人脸，已按画面居中裁剪'}
          </Text>
          {cropInfo.notes && cropInfo.notes.length ? (
            <Text
              className='crop-info__warn'
              style={{ display: 'block', fontSize: '12px', color: cropInfo.degraded ? '#c62828' : '#e07b00', marginTop: '4px' }}
            >
              {cropInfo.degraded ? '⚠ ' : ''}
              {cropInfo.notes.join('；')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* 输出构图提示（分辨率不足 / 达到处理上限 → 如实告知，不静默输出糊图） */}
      {planNote ? (
        <Text style={{ display: 'block', fontSize: '12px', color: '#e07b00', marginTop: '6px' }}>
          {planNote}
        </Text>
      ) : null}

      {preview ? (
        <View style={{ marginTop: '14px' }}>
          <Image src={preview} style={{ width: '100%', height: '260px' }} mode='aspectFit' />
          {/* 头部占比（PRD B3）：实测值 + 来源标注；未检测时说明原因 */}
          {headInfo ? (
            <View style={{ padding: '8px 0' }}>
              <Text style={{ fontSize: '13px', color: '#333' }}>
                头部占比{' '}
                {headInfo.ratio != null
                  ? `${(headInfo.ratio * 100).toFixed(0)}%`
                  : '未检测到'}
                {headInfo.source === 'estimate' ? '（估算）' : ''}
                {headInfo.quality === 'low' ? '（可信度低）' : ''}
              </Text>
              {headInfo.notes && headInfo.notes.length ? (
                <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '2px' }}>
                  {headInfo.notes.join('；')}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={{ display: 'block', fontSize: '12px', color: '#999', marginTop: '6px' }}>
              头部占比：未检测到人脸，当前环境不支持人脸检测
            </Text>
          )}
          {/* 手动修补（PRD B1 / T1-17，任务 #42）：低置信边缘自行涂改修正 */}
          <Button style={{ marginTop: '8px' }} onClick={() => setPatching(true)} disabled={!patchBase || busy}>
            ✏️ 手动修补边缘
          </Button>
          {patching && patchBase ? (
            <AlphaPatch
              workPreviewPath={patchBase.workPreviewPath}
              workW={patchBase.w}
              workH={patchBase.h}
              onApply={(strokes: any[]) => regenerate(strokes)}
              onCancel={() => setPatching(false)}
            />
          ) : null}

          {/* 受限美颜（PRD E 章 / AC2，任务 #38）：折叠控制面板，开启后调节并重新生成 */}
          <BeautyControl
            value={beauty}
            onChange={setBeauty}
            onApply={() => {
              if (lastPick) run(lastPick.path, lastPick.width, lastPick.height);
            }}
          />

          {/* AI 换装（可选，PRD D 章 / T1-11/12，任务 #43）：端侧贴图合成 + 强制五官自检 */}
          <View style={{ marginTop: '10px', padding: '10px', borderRadius: '6px', border: '1px solid #e6e6e6', background: '#fafafa' }}>
            <View onClick={() => setSuitPanelOpen(!suitPanelOpen)}>
              <Text style={{ fontWeight: 'bold' }}>{suitPanelOpen ? '▾ ' : '▸ '}👔 AI 换装（可选）</Text>
              <Text style={{ display: 'block', fontSize: '12px', color: '#999', marginTop: '2px' }}>
                {suitApplied ? '已换装（更换模板后请点「应用换装」）' : '点开可选职业装模板；仅换装、不改五官'}
              </Text>
            </View>
            {suitPanelOpen ? (
              <View style={{ marginTop: '8px' }}>
                {/* suitSwap 单独授权（个保法敏感信息单独同意 / AC5） */}
                {!granted.includes('suitSwap') ? (
                  <View
                    onClick={() => toggleConsent('suitSwap')}
                    style={{ border: '1px solid #ddd', background: '#fff', padding: '8px', borderRadius: '6px', marginBottom: '8px' }}
                  >
                    <Text>☐ {SUIT_CONSENT.label}（需单独授权）</Text>
                    <Text className='consent__desc'>{SUIT_CONSENT.desc}</Text>
                  </View>
                ) : (
                  <Text style={{ display: 'block', fontSize: '12px', color: '#2e7d32', marginBottom: '8px' }}>✓ 已授权 AI 换装</Text>
                )}
                {/* 职业装模板（自绘素材，AI 自绘自有版权，PRD Q3 合规） */}
                <View style={{ display: 'flex', flexDirection: 'row' }}>
                  {SUIT_TEMPLATES.map((t, i) => (
                    <View
                      key={t.id}
                      onClick={() => setSuitTplIndex(i)}
                      style={{
                        flex: 1,
                        marginRight: i < SUIT_TEMPLATES.length - 1 ? '8px' : 0,
                        padding: '6px 4px',
                        borderRadius: '6px',
                        textAlign: 'center',
                        border: suitTplIndex === i ? '2px solid #333' : '1px solid #ccc',
                        background: suitTplIndex === i ? '#eef5fd' : '#fff',
                      }}
                    >
                      <Image src={t.src as any} style={{ width: '44px', height: '44px' }} mode='aspectFit' />
                      <Text style={{ display: 'block', fontSize: '12px', marginTop: '2px' }}>{t.name}</Text>
                    </View>
                  ))}
                </View>
                <View style={{ display: 'flex', flexDirection: 'row', marginTop: '8px' }}>
                  <Button size='mini' style={{ marginRight: '8px' }} loading={busy} disabled={busy} onClick={applySuit}>应用换装</Button>
                  {suitApplied ? <Button size='mini' onClick={cancelSuit}>取消换装</Button> : null}
                </View>
                <Text style={{ display: 'block', fontSize: '11px', color: '#999', marginTop: '6px' }}>
                  端侧贴图合成，只覆盖肩颈区域、不改五官；换装后须完成五官自检方可导出。
                </Text>
              </View>
            ) : null}
          </View>

          {/* D3/AC6 强制五官自检：换装后未确认不得导出 */}
          {suitApplied ? (
            <View
              className='selfcheck'
              onClick={() => setSelfChecked(!selfChecked)}
              style={{ marginTop: '10px', padding: '10px', borderRadius: '6px', border: selfChecked ? '1px solid #438EDB' : '1px solid #ddd', background: selfChecked ? '#eef5fd' : '#fff' }}
            >
              <Text style={{ fontWeight: 'bold' }}>{selfChecked ? '☑ ' : '☐ '}五官自检（PRD D3 / AC6）</Text>
              <Text style={{ display: 'block', fontSize: '12px', color: '#666', marginTop: '4px' }}>
                请核对：换装后的照片五官未被改动。端侧合成只覆盖肩颈区域，理论上不触碰脸部像素；如发现五官异常请勿导出，重拍或换模板。未确认自检无法导出。
              </Text>
            </View>
          ) : null}

          {/* AC1 镜像自查（导出前勾选，未勾选禁用保存） */}
          {picker.MirrorCheck}
          <Button
            style={{ marginTop: '8px' }}
            onClick={save}
            disabled={!picker.mirrorConfirmed || (suitApplied && !selfChecked)}
          >
            {suitApplied && !selfChecked ? '请先完成五官自检' : '保存到相册'}
          </Button>
          {/* PRD K1 入口①：另存为排版版 → T6 冲印排版（纯拼版，不需要人脸授权） */}
          <Button
            style={{ marginTop: '8px' }}
            onClick={goPrintLayout}
          >
            🖨️ 另存为冲印排版（拼版打印）
          </Button>
        </View>
      ) : null}

      {/* 合规预审结果 */}
      {result ? (
        <View style={{ marginTop: '14px' }}>
          <Text style={{ fontWeight: 'bold' }}>
            合规预审：{result.pass ? '全部通过' : '有不通过项'}
          </Text>
          {result.checks.map((c: any) => (
            <View key={c.key} style={{ padding: '6px 0' }}>
              <Text
                className={c.level === 'advisory' ? 'result__warn' : (c.pass ? 'result__ok' : 'result__bad')}
                style={{ color: c.level === 'advisory' ? '#e07b00' : (c.pass ? '#2e7d32' : '#c62828') }}
              >
                {c.level === 'advisory' ? 'ⓘ' : (c.pass ? '✓' : '✗')} {c.label}
                {c.level === 'advisory' ? '（提示项）' : ''}
              </Text>
              <Text style={{ display: 'block', fontSize: '12px', color: '#888' }}>{c.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* A1 半透明人脸引导框：拍摄入口（相册走上方 .btn-primary） */}
      {picker.Guide}
      {/* A3 原图质量提示（非阻断，建议性） */}
      {picker.QualityTip}
    </View>
  );
}
