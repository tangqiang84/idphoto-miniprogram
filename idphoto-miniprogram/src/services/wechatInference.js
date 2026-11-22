'use strict';
// 平台适配：把微信ArrayBuffer Tensor桥接到现有ORT风格接口，不引入浏览器运行时。
function createWechatRuntime(platform, options = {}) {
  if (typeof platform?.createInferenceSession !== 'function') return null;
  const inputName = options.inputName || 'input', outputName = options.outputName || 'output';
  const size = options.inputSize || 512, timeoutMs = options.timeoutMs || 15000;
  const inputShape = options.inputShape || [1,3,size,size];
  const outputShape = options.outputShape || [1,1,size,size];
  if (![inputShape,outputShape].every(s=>Array.isArray(s)&&s.length===4&&s.every(v=>Number.isSafeInteger(v)&&v>0))) return null;
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  }
  return { Tensor, InferenceSession: { create(model) {
    return new Promise((resolve, reject) => {
      let raw, settled = false, destroyed = false, busy = false, timer;
      const traceId = 'wx-model-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const stage = name => { try { options.onStage?.(name); } catch { console.warn('[model]', { code: 'MODEL_OBSERVER_FAILED', traceId }); } };
      const error = code => { console.warn('[model]', { code, traceId }); return { code, message: '端侧模型暂不可用', traceId }; };
      const release = () => { if (!destroyed) { destroyed = true; try { raw?.destroy(); } catch { console.warn('[model]', { code: 'MODEL_RELEASE_FAILED', traceId }); } } };
      const cleanup = () => { clearTimeout(timer); try { raw?.offLoad?.(loaded); raw?.offError?.(failed); } catch { console.warn('[model]', { code: 'MODEL_LISTENER_RELEASE_FAILED', traceId }); } };
      const failed = () => { if (settled) return; settled = true; stage('native-load-error'); cleanup(); release(); reject(error('MODEL_RUNTIME_INVALID')); };
      const loaded = () => {
        if (settled) return;
        settled = true; stage('native-load-ready'); cleanup();
        resolve({ inputNames: [inputName], outputNames: [outputName], release,
          async run(feeds) {
            if (destroyed) throw error('MODEL_SESSION_RELEASED');
            if (busy) throw error('MODEL_SESSION_BUSY');
            const t = feeds[inputName];
            if (!t || t.type !== 'float32' || !(t.data instanceof Float32Array) || !Array.isArray(t.dims) || t.dims.join(',') !== inputShape.join(',') || t.data.length !== inputShape.reduce((a,b)=>a*b,1)) throw error('MODEL_TENSOR_INVALID');
            // slice避免TypedArray子视图把同缓冲区的其他数据一并传入。
            const data = t.data.buffer.slice(t.data.byteOffset, t.data.byteOffset + t.data.byteLength);
            let result, runTimer;
            busy = true; stage('native-run-entered');
            try {
              result = await Promise.race([
                Promise.resolve().then(() => raw.run({ [inputName]: { type: 'float32', shape: t.dims, data } })),
                new Promise((_, reject) => { runTimer = setTimeout(() => reject(error('MODEL_INFERENCE_TIMEOUT')), timeoutMs); }),
              ]);
            } catch (e) { release(); console.warn('[model]', { code: e?.code === 'MODEL_INFERENCE_TIMEOUT' ? e.code : 'MODEL_INFERENCE_FAILED', traceId }); throw error(e?.code === 'MODEL_INFERENCE_TIMEOUT' ? e.code : 'MODEL_INFERENCE_FAILED'); }
            finally { clearTimeout(runTimer); busy = false; }
            if (destroyed) throw error('MODEL_SESSION_RELEASED');
            stage('native-run-returned');
            const out = result?.[outputName];
            const outputMetadata = {
              names: Object.keys(result || {}).slice(0,8).map(n=>n.slice(0,40)),
              tensorType: typeof out?.type === 'string' ? out.type.slice(0,32) : typeof out?.type,
              shape: Array.isArray(out?.shape) ? out.shape.slice(0,8) : ArrayBuffer.isView(out?.shape) ? Array.from(out.shape).slice(0,8) : null,
              shapeKind: Object.prototype.toString.call(out?.shape),
              dataKind: Object.prototype.toString.call(out?.data),
              byteLength: typeof out?.data?.byteLength === 'number' ? out.data.byteLength : null,
              bufferInstance: out?.data instanceof ArrayBuffer,
              bufferView: ArrayBuffer.isView(out?.data),
            };
            const publish = metadata => { try { options.onOutputMetadata?.(metadata); } catch { console.warn('[model]', { code:'MODEL_OBSERVER_FAILED', traceId }); } };
            publish(outputMetadata);
            if (!out || out.type !== 'float32' || !(out.data instanceof ArrayBuffer) || !Array.isArray(out.shape) || out.shape.join(',') !== outputShape.join(',') || out.data.byteLength !== outputShape.reduce((a,b)=>a*b,1)*4) throw error('MODEL_OUTPUT_INVALID');
            const values = new Float32Array(out.data);
            let nonFiniteCount=0;
            for(const value of values)if(!Number.isFinite(value))nonFiniteCount++;
            publish({...outputMetadata,nonFiniteCount});
            if (nonFiniteCount) throw error('MODEL_OUTPUT_INVALID');
            return { [outputName]: { data: values, dims: out.shape, type: out.type } };
          } });
      };
      try {
        stage('native-create-entered');
        raw = platform.createInferenceSession({ model, precisionLevel: 4, allowNPU: false, allowQuantize: false,
          typicalShape: { [inputName]: inputShape.slice() } });
        stage('native-create-returned');
        if (!raw || !['onLoad','onError','run','destroy'].every(k => typeof raw[k] === 'function')) { failed(); return; }
        timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); release(); reject(error('MODEL_TIMEOUT')); } }, timeoutMs);
        raw.onError(failed); raw.onLoad(loaded);
      } catch { failed(); }
    });
  } } };
}
module.exports = { createWechatRuntime };
