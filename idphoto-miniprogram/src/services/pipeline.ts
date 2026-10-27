// 共享取图管线（P1 / 台账 #75，方案 [F1]）：**先裁剪到目标规格，再抠图/换底/换装**
//
// 【为什么要重排】原链路是「上传 → 抠图 → 换底 → 最后才裁剪到规格」：
//   · matting 跑在**整张原图**上，alpha 噪声会外溢到最终构图之外的人体/背景区域，
//     而 tightBBox / 行宽突变这类几何判据恰恰直接吃 alpha（#69 第三层根因）；
//   · T2 甚至允许「不选规格 = 保持原图尺寸」，换底色后构图不受规格约束。
// 重排为「勾协议 → 选图 → **裁剪到规格** → 抠图 → 换底/换装 → 导出」后：
//   ① matting 在最终构图内运行（噪声不外溢）；② 与 R1「换装只针对 9 规格画布」完全同向；
//   ③ T1/T2/T3 共享同一段底层，回归面收敛（方案 2.6 工程判定）。
//
// 【本文件的来源】逻辑原样抽自 T1（pages/tool-idphoto 第 180~278 行，任务 #24 已验证），
// 不是新写的算法 —— 抽出来是为了让 T2/T3 用同一份，避免"同产品两种流程"。
import Taro from '@tarojs/taro';
import { withTimeout, IMG_LOAD_TIMEOUT_MS } from '../core/asyncUtils';
import { planOutput, planWindowOutput, planDetectImage } from '../core/compose';
import { planHeadCrop } from '../core/headCrop';
import { collectEdgeSamples } from '../core/matting';
import { measureHeadMetrics } from './faceService';

export interface PrepareParams {
  /** 源图临时路径 */
  path: string;
  srcW: number;
  srcH: number;
  /** 目标规格（specLibrary 的 spec 对象） */
  spec: any;
  /** 输出 dpi（决定 target 像素） */
  dpi: number;
  /** target 像素（由调用方用 getPixelSize 算好传入，避免重复计算） */
  target: { width: number; height: number };
  /** 阶段文案回调（页面状态行） */
  onMsg?: (s: string) => void;
}

export interface Prepared {
  /** 工作画布尺寸 */
  w: number;
  h: number;
  /** 工作画布像素（裁剪窗 + 余量，已放大到足够像素） */
  rgba: Uint8ClampedArray;
  /** 工作画布（离屏 canvas，供 pose 编码 / 修补面板复用） */
  canvas: any;
  /** 构图规划（含导出裁剪窗 sx,sy,sw,sh 与 scale） */
  plan: any;
  /** 智能裁切结果（null = 未检出人脸，已降级居中裁剪） */
  crop: any;
  /** 人脸度量（**原图坐标**；换算回工作图用 ×plan.scale） */
  srcMetrics: any;
  /** 背景色采样（自动裁剪路径下才需要，注入抠图以稳定背景估计） */
  bgSamples: any;
  /** 构图提示文案 */
  reason: string;
}

/**
 * 准备「已裁剪到目标规格」的工作画布。
 * 抛错时消息对用户可读（页面直接上状态行）。
 */
export async function prepareWorkCanvas(p: PrepareParams): Promise<Prepared> {
  const anyTaro: any = Taro;
  if (typeof anyTaro.createOffscreenCanvas !== 'function') {
    throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
  }

  // 统一的取像素助手（检测用图与工作画布共用同一张源图）
  const loadRgba = async (cw: number, ch: number, draw: (ctx: any, img: any) => void) => {
    const cv = anyTaro.createOffscreenCanvas({ type: '2d', width: cw, height: ch });
    const cx = cv.getContext('2d');
    const im = cv.createImage();
    // #70：图片加载加超时硬闸门（真机上 onload/onerror 可能双不触发 → 永久转圈）
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        im.onload = () => resolve();
        im.onerror = (e: any) => reject(e || new Error('图片加载失败'));
        im.src = p.path;
      }),
      IMG_LOAD_TIMEOUT_MS,
      '图片加载超时',
    );
    draw(cx, im);
    const id = cx.getImageData(0, 0, cw, ch);
    return { canvas: cv, ctx: cx, imageData: id, rgba: id.data as Uint8ClampedArray };
  };

  // 1. 人脸检测（在【检测用图】上做：长边 ≤ DETECT_EDGE，兼顾精度与内存）
  if (p.onMsg) p.onMsg('识别人脸…');
  const det = planDetectImage(p.srcW, p.srcH);
  if (!det) throw new Error('图片尺寸读取失败，请换一张照片');
  const detImg = await loadRgba(det.width, det.height, (cx, im) => {
    cx.drawImage(im, 0, 0, det.width, det.height);
  });
  const fm = await measureHeadMetrics(detImg.rgba, det.width, det.height, null);
  // 换算回原图坐标（检测用图是原图等比缩放，比例不变）
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

  // 2. 反解裁剪框（按规格头占比区间中值，core/headCrop.js）
  let crop: any = null;
  let plan: any = null;
  if (srcMetrics) {
    crop = planHeadCrop({
      workW: p.srcW,
      workH: p.srcH,
      targetW: p.target.width,
      targetH: p.target.height,
      crownY: srcMetrics.crownY,
      chinY: srcMetrics.chinY,
      faceCenterX: srcMetrics.faceCenterX,
      ratioMin: p.spec.headHeightRatioMin,
      ratioMax: p.spec.headHeightRatioMax,
    });
  }
  if (crop) {
    // 2.1 区域化工作画布：只把「要用到的那块」放大到足够像素，避免成品是放大糊图
    plan = planWindowOutput(p.srcW, p.srcH, p.target.width, p.target.height, {
      sx: crop.sx, sy: crop.sy, sw: crop.sw, sh: crop.sh,
    });
  }
  if (!plan) {
    // 降级：未检出人脸 / 反解失败 → 按目标宽高比居中裁剪（与 #24 前行为一致）
    plan = planOutput(p.srcW, p.srcH, p.target.width, p.target.height);
  }
  if (!plan) throw new Error('图片尺寸读取失败，请换一张照片');

  // 3. 取工作画布像素（自动裁剪路径只画「裁剪窗 + 余量」）
  const w = plan.workW;
  const h = plan.workH;
  const work = await loadRgba(w, h, (cx, im) => {
    if (plan.regionX != null) {
      cx.drawImage(im, plan.regionX, plan.regionY, plan.regionW, plan.regionH, 0, 0, w, h);
    } else {
      cx.drawImage(im, 0, 0, w, h);
    }
  });

  // 4. 背景色采样（自动裁剪时工作画布四边可能压在头发/肩膀上 → 用检测用图采样注入）
  const bgSamples = crop ? collectEdgeSamples(detImg.rgba, det.width, det.height, 2) : undefined;

  return {
    w,
    h,
    rgba: work.rgba,
    canvas: work.canvas,
    plan,
    crop,
    srcMetrics,
    bgSamples,
    reason: plan.reason || '',
  };
}
