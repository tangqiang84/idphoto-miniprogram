/**
 * 端侧真实抠图 · 小程序 ort 适配层
 * ----------------------------------------------------------------
 * 【2026-10-23 任务 #3 重构说明（原文件随基线提交 02c6e6d 入库，从未被引用）】
 *
 * 原实现有三个问题，本次一并修正：
 *   1. `import * as ort from 'onnxruntime-web'` 是**静态依赖**，但项目里根本没装它
 *      → 一直有一条 TS2307 基线告警。且项目硬约束禁止在项目内 npm install 新包
 *      （会重排 node_modules/webpack，有把 webpack 从 5.89.0 升上去、破坏 Taro 3.6.23 构建的风险）。
 *      现改为**注入式**：ort 由调用方通过构造函数传入，本文件不再产生编译期依赖。
 *   2. 硬编码 RMBG-1.4 / 1024 / ImageNet 归一化 —— RMBG-1.4 **权重为非商业许可**
 *      （BRIA：Commercial use is subject to a commercial agreement），本项目属商业使用，不能用。
 *      且 1024+ImageNet 是 RMBG 的规格，换模型（如 MODNet 需 512 + 归一化到 [-1,1]）就会静默失真。
 *      现改为由 core/mattingModel 的规格表驱动，模型自己声明输入尺寸与归一化方式。
 *   3. 原注释写「180MB 模型打包进分包」—— 小程序单包上限 2MB、总包 20MB，180MB 不可能打包；
 *      只能运行时下载到 USER_DATA_PATH（见 services/modelService.ts）。注释已更正。
 *
 * 【职责边界】
 *   本文件只做「小程序端 ort session 的封装 + 推理调用」；
 *   权重的下载/缓存/校验/降级决策在 services/modelService.ts，
 *   预处理与后处理的数值逻辑在 core/mattingModel.js（纯 JS、可单测）。
 *   三者分层，避免逻辑散落。
 */

// 推理运行时（onnxruntime）。**不静态 import** —— 由调用方注入，见下方 OrtRuntime 说明。
export interface OrtRuntime {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => any;
  InferenceSession: { create(input: any, opts?: any): Promise<any> };
  env?: { wasm?: { wasmPaths?: any; numThreads?: number } };
  [k: string]: any;
}

export interface MattingResult {
  /** 单通道 alpha，长度 = w*h，取值 0~1 */
  alpha: Float32Array;
  width: number;
  height: number;
  /** 形如 'onnx:modnet-q8'，便于日志与 UI 区分「真模型」与「经典基线(classical)」 */
  backend: string;
}

export interface LocalMattingOpts {
  ort: OrtRuntime;
  /** 来自 core/mattingModel.MODEL_SPECS 的规格对象（含 inputSize / normalize / output） */
  spec: any;
  /** wasm 资源路径。小程序端须放分包内本地路径，不能用 CDN（隐私合规「不出端」） */
  wasmPaths?: any;
}

export class LocalMattingModel {
  private ort: OrtRuntime;
  private spec: any;
  private wasmPaths?: any;
  private session: any = null;

  constructor(opts: LocalMattingOpts) {
    if (!opts || !opts.ort) throw new Error('LocalMattingModel: 需要注入 ort 运行时');
    if (!opts.spec) throw new Error('LocalMattingModel: 需要传入模型规格（core/mattingModel.MODEL_SPECS）');
    this.ort = opts.ort;
    this.spec = opts.spec;
    this.wasmPaths = opts.wasmPaths;
  }

  get loaded() {
    return !!this.session;
  }

  /**
   * 加载模型。入参可以是：
   *   - 本地文件路径（string）：先用 wx.getFileSystemManager 读成 ArrayBuffer
   *   - ArrayBuffer / Uint8Array：直接送 ort
   * 小程序端传路径（权重已由 modelService 下载到 USER_DATA_PATH）。
   */
  async load(modelInput: string | ArrayBuffer | Uint8Array): Promise<void> {
    // 单线程：小程序逻辑层没有 Web Worker，多线程 EP 会失败
    if (this.ort.env && this.ort.env.wasm) {
      if (this.wasmPaths) this.ort.env.wasm.wasmPaths = this.wasmPaths;
      this.ort.env.wasm.numThreads = 1;
    }

    let input: any = modelInput;
    if (typeof modelInput === 'string') {
      const w = wx.getFileSystemManager();
      input = await new Promise<any>((resolve, reject) => {
        w.readFile({ filePath: modelInput, success: (r: any) => resolve(r.data), fail: reject });
      });
    }

    this.session = await this.ort.InferenceSession.create(input, { executionProviders: ['wasm'] });
  }

  async infer(rgba: Uint8ClampedArray, w: number, h: number): Promise<MattingResult> {
    if (!this.session) throw new Error('LocalMattingModel: 模型未加载，请先调用 load()');
    const size = this.spec.inputSize;
    // 预处理与后处理统一走 core/mattingModel —— 不在本文件重复实现，
    // 避免「两套 resize / 两套归一化」悄悄漂移。
    const { preprocess, postprocess } = require('../core/mattingModel');
    const input = preprocess(rgba, w, h, this.spec);
    const tensor = new this.ort.Tensor('float32', input, [1, 3, size, size]);
    const feeds: Record<string, any> = {};
    // 输入名优先取规格声明（部分导出工具不给 inputNames）
    const inName = this.spec.inputName || (this.session.inputNames && this.session.inputNames[0]);
    if (!inName) throw new Error('LocalMattingModel: 无法确定模型输入名');
    feeds[inName] = tensor;
    const out = await this.session.run(feeds);
    const outName = this.session.outputNames && this.session.outputNames[0];
    const raw = out[outName] ? out[outName].data : out[Object.keys(out)[0]].data;
    const alpha = postprocess(raw, this.spec, w, h);
    return { alpha, width: w, height: h, backend: `onnx:${this.spec.id}` };
  }

  /** 释放 session（页面卸载或切换模型时调用，避免内存堆积） */
  dispose() {
    try { if (this.session && typeof this.session.release === 'function') this.session.release(); } catch (e) { /* 忽略释放失败 */ }
    this.session = null;
  }
}
