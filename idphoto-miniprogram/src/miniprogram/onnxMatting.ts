/**
 * 端侧真实抠图接入（微信小程序）
 * ----------------------------------------------------------------
 * 运行时依赖：onnxruntime-web（WASM 后端）。模型：RMBG-1.4 ONNX（约 180MB，需打包进小程序分包或首启下载到本地）。
 *
 * 关键约束（微信小程序环境）：
 *  1. WASM 文件必须放在「分包」内，并显式设置 ort.env.wasm.wasmPaths 指向本地包路径；
 *     不能用 CDN 远程加载（小程序限制 + 隐私合规「不出端」）。
 *  2. 多线程 wasm 在小程序 worker 支持有限，先用 single-thread 保稳；
 *     若需提速，再开启 `ort.env.wasm.numThreads` 并配套 worker。
 *  3. 输入张量 1024×1024 float32（HWC→CHW + ImageNet 归一化），输出单通道 alpha（0~1）。
 *  4. 该路径完全在端侧执行，不联网、不留存、不训练 —— 对应 PRD 隐私合规的「人脸本地优先」。
 */

import * as ort from 'onnxruntime-web';

// 分包内 wasm 目录（需把 onnxruntime-web/dist/*.wasm 拷到此处）
const WASM_DIR = 'onnxruntime-web/wasm/';
const MODEL_PATH = 'models/rmbg-1.4.onnx'; // 分包内模型文件
const INPUT_SIZE = 1024;

export interface MattingResult {
  /** 单通道 alpha，长度 = w*h，取值 0~1 */
  alpha: Float32Array;
  width: number;
  height: number;
  backend: 'rmbg-1.4';
}

export class LocalMattingModel {
  private session: ort.InferenceSession | null = null;

  /** 加载模型与 wasm 运行时（应在「隐私单独授权」之后调用） */
  async load(modelPath: string = MODEL_PATH): Promise<void> {
    // 本地包路径 → arraybuffer（小程序必须用 wx.getFileSystemManager 读分包文件）
    const fs = wx.getFileSystemManager();
    const pkgPath = `${wx.env.USER_DATA_PATH}/${modelPath}`;
    const modelData = await new Promise<ArrayBuffer>((resolve, reject) => {
      fs.readFile({ filePath: pkgPath, success: (r) => resolve(r.data as ArrayBuffer), fail: reject });
    });

    ort.env.wasm.wasmPaths = WASM_DIR;
    ort.env.wasm.numThreads = 1; // 单线程保稳，后续可提
    this.session = await ort.InferenceSession.create(modelData, { executionProviders: ['wasm'] });
  }

  async infer(rgba: Uint8ClampedArray, w: number, h: number): Promise<MattingResult> {
    if (!this.session) throw new Error('model not loaded');
    const input = this.preprocess(rgba, w, h);
    const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const feeds: Record<string, ort.Tensor> = {};
    feeds[this.session.inputNames[0]] = tensor;
    const out = await this.session.run(feeds);
    const raw = out[this.session.outputNames[0]].data as Float32Array; // [1,1,1024,1024]
    const alpha = this.resizeBilinear(raw, INPUT_SIZE, INPUT_SIZE, w, h);
    return { alpha, width: w, height: h, backend: 'rmbg-1.4' };
  }

  private preprocess(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
    const src = this.resizeBilinearRGBA(rgba, w, h, INPUT_SIZE, INPUT_SIZE);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const out = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    for (let y = 0; y < INPUT_SIZE; y++) for (let x = 0; x < INPUT_SIZE; x++) {
      const si = (y * INPUT_SIZE + x) * 4;
      out[(0 * INPUT_SIZE + y) * INPUT_SIZE + x] = (src[si] / 255 - mean[0]) / std[0];
      out[(1 * INPUT_SIZE + y) * INPUT_SIZE + x] = (src[si + 1] / 255 - mean[1]) / std[1];
      out[(2 * INPUT_SIZE + y) * INPUT_SIZE + x] = (src[si + 2] / 255 - mean[2]) / std[2];
    }
    return out;
  }

  private resizeBilinearRGBA(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(dw * dh * 4);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
      const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
      for (let x = 0; x < dw; x++) {
        const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
        for (let c = 0; c < 4; c++) {
          const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c];
          const cc = src[(y1 * sw + x0) * 4 + c], d = src[(y1 * sw + x1) * 4 + c];
          out[(y * dw + x) * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
        }
      }
    }
    return out;
  }

  private resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
    const out = new Float32Array(dw * dh);
    const sx = sw / dw, sy = sh / dh;
    for (let y = 0; y < dh; y++) {
      const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
      for (let x = 0; x < dw; x++) {
        const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
        const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
        out[y * dw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    return out;
  }
}
