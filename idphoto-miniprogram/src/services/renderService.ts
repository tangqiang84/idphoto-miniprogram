import Taro from '@tarojs/taro';
import { composite, compositeTransparent } from '../core/matting';
import { withTimeout, EXPORT_TIMEOUT_MS } from '../core/asyncUtils';

/**
 * 共享渲染服务：合成（换底色）+ 可选裁剪 + 导出临时文件。
 *
 * 存在的意义（任务 #50，2026-10-27 真机反馈）：
 *   T1/T2/T3 三页原本各自复制了一份「合成→裁剪→导出」代码，且**换底色只改 state、
 *   不重新合成**——用户在真机上选了「标准深蓝」，导出的成品仍是白底（#FFFFFF）。
 *   本服务把这三步收敛成一份实现，让「换底色」可以**只重跑合成**（秒级，不重跑抠图），
 *   避免用户为了换个底色再选一次图。
 */
export interface RenderParams {
  /** 工作画布 RGBA（抠图/换装后的像素） */
  rgba: Uint8ClampedArray;
  /** 抠图 alpha（Float32Array 或 Uint8ClampedArray 均可） */
  alpha: Uint8ClampedArray | number[];
  /** 工作画布宽高 */
  w: number;
  h: number;
  /** 底色 HEX；传 null = 透明底（导出 PNG 保留 alpha） */
  bgHex: string | null;
  /** 裁剪窗口（planOutput / planWindowOutput 的 sx,sy,sw,sh）；与 target 同时给才裁剪 */
  plan?: { sx: number; sy: number; sw: number; sh: number } | null;
  /** 目标像素尺寸（给则裁剪缩放到该尺寸） */
  target?: { width: number; height: number } | null;
  fileType?: 'jpg' | 'png';
  quality?: number;
}

export interface RenderResult {
  /** 导出后的临时文件路径 */
  preview: string;
  /** 文件大小（KB） */
  fileKb: number;
  outW: number;
  outH: number;
}

/**
 * 合成 + 可选裁剪 + 导出。
 * @throws 基础库不支持离屏 canvas / 导出失败
 */
export async function composeAndExportImage(p: RenderParams): Promise<RenderResult> {
  const anyTaro: any = Taro;
  if (typeof anyTaro.createOffscreenCanvas !== 'function') {
    throw new Error('当前基础库不支持离屏 canvas，请升级基础库到 2.16.1+');
  }

  const transparent = p.bgHex === null || p.bgHex === undefined;
  const composed = transparent
    ? compositeTransparent(p.rgba, p.alpha, p.w, p.h)
    : composite(p.rgba, p.alpha, p.w, p.h, p.bgHex as string);

  // 注：不使用 createImageData —— 微信部分基础库对它报 "Value is not of type 'long'"（台账 #10）。
  // 改为新建画布 + getImageData 承载像素后 putImageData 写回。
  const cv: any = anyTaro.createOffscreenCanvas({ type: '2d', width: p.w, height: p.h });
  const cx: any = cv.getContext('2d');
  const blank: any = cx.getImageData(0, 0, p.w, p.h);
  blank.data.set(composed);
  cx.putImageData(blank, 0, 0);

  let outCanvas = cv;
  let outW = p.w;
  let outH = p.h;
  if (p.plan && p.target) {
    outCanvas = anyTaro.createOffscreenCanvas({ type: '2d', width: p.target.width, height: p.target.height });
    const octx: any = outCanvas.getContext('2d');
    octx.drawImage(cv, p.plan.sx, p.plan.sy, p.plan.sw, p.plan.sh, 0, 0, p.target.width, p.target.height);
    outW = p.target.width;
    outH = p.target.height;
  }

  // #70：导出段同样加超时硬闸门（canvasToTempFilePath / getFileInfo 在真机上
  // 若永不回调，页面同样会永久转圈）
  const exported: any = await withTimeout(
    Taro.canvasToTempFilePath({
      canvas: outCanvas,
      x: 0, y: 0, width: outW, height: outH,
      destWidth: outW, destHeight: outH,
      fileType: transparent ? 'png' : (p.fileType || 'jpg'),
      quality: p.quality ?? 0.95,
    }),
    EXPORT_TIMEOUT_MS,
    'export: 画布导出超时',
  );

  const fs = Taro.getFileSystemManager();
  const fi: any = await withTimeout(
    new Promise((resolve, reject) => {
      fs.getFileInfo({ filePath: exported.tempFilePath, success: resolve, fail: reject });
    }),
    EXPORT_TIMEOUT_MS,
    'export: 文件信息读取超时',
  );

  return { preview: exported.tempFilePath, fileKb: Math.round(fi.size / 1024), outW, outH };
}
