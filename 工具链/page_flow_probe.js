'use strict';
// 执行当前页面控制代码；平台/图像算法被替换，不冒充微信UI或真实模型验证。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const ts = require(path.join(ROOT, 'idphoto-miniprogram/node_modules/typescript'));
const spec = require('../idphoto-miniprogram/src/core/specLibrary');
const privacy = require('../idphoto-miniprogram/src/core/privacy');
const compose = require('../idphoto-miniprogram/src/core/compose');
const { beforeCropConfirmation } = require('./acceptance_oracles');
const compiled = new Map();
function compile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const key = file + crypto.createHash('sha256').update(source).digest('hex');
  if (!compiled.has(key)) compiled.set(key, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText);
  return compiled.get(key);
}


async function probePage(tool, options = {}) {
  const pages = { T1: 'tool-idphoto', T2: 'tool-bg', T3: 'tool-suit', T4: 'tool-check', T5: 'tool-spec', T6: 'tool-print' };
  if (!pages[tool]) throw new Error('PROBE_TOOL_UNSUPPORTED');
  // 编译不属于页面JS执行；预先完成，避免VM父模块的2秒执行限制包含递归TS编译耗时。
  const preload = ['src/pages/' + pages[tool] + '/index.tsx', 'src/hooks/useConsentGate.ts'];
  if (['T1','T2','T3','T5'].includes(tool)) preload.push('src/hooks/useT1Workflow.ts', 'src/services/t1Processing.ts');
  if (['T2','T3','T5'].includes(tool)) preload.push('src/components/PhotoTool/index.tsx');
  if (['T2', 'T3', 'T4'].includes(tool)) preload.push('src/hooks/useActionConsent.ts');
  if (options.actualPicker) preload.push('src/hooks/useImagePicker.tsx');
  for (const name of preload) compile(path.join(ROOT, 'idphoto-miniprogram', name));
  const state = [];
  let cursor = 0;
  let observedSession;
  let observedFlow;
  const effects = [];
  const cleanup = [];
  let imageHandler;
  let imageDelivered = false;
  let cropConfirmed = false;
  const events = [];
  let runtimeErrors = 0;
  const loaded = {};
  for (const name of ['specLibrary', 'privacy', 'compose']) {
    const file = require.resolve('../idphoto-miniprogram/src/core/' + name);
    loaded[path.relative(ROOT, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  const cache = {};
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [state[slot], (next) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }];
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      const previous = state[slot];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        state[slot] = { deps };
        effects.push(() => { if (previous?.cancel) previous.cancel(); const cancel = fn(); state[slot].cancel = cancel; if (cancel) cleanup.push(cancel); });
      }
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in state)) state[slot] = { current: initial };
      return state[slot];
    },
  };
  const record = (kind) => events.push({ kind, cropConfirmed: observedSession ? observedSession.getState().params.cropConfirmed : cropConfirmed });
  const stop = (kind) => { record(kind); throw new Error('RC03_PROBE_STOP_AFTER_CALL'); };
  const canvas = ({width=640,height=800}={}) => ({
    getContext: () => ({ drawImage() {}, putImageData() {}, getImageData: (_x,_y,w=width,h=height) => ({ data: new Uint8ClampedArray(w * h * 4) }) }),
    createImage() {
      const image = {};
      Object.defineProperty(image, 'src', { set() { queueMicrotask(() => image.onload && image.onload()); } });
      return image;
    },
  });
  const taro = {
    showToast() {}, createOffscreenCanvas: canvas,
    canvasToTempFilePath: async () => stop('product-export'),
    getFileSystemManager: () => ({ getFileInfo: ({ success }) => success({ size: 1024 }) }),
    saveImageToPhotosAlbum: async () => stop('save'),
    ...options.taro,
  };
  const services = {
    ...spec, ...privacy, ...compose,
    ...require('../idphoto-miniprogram/src/core/matting'),
    ...require('../idphoto-miniprogram/src/core/compliance'),
    ...require('../idphoto-miniprogram/src/core/suit'),
    ...require('../idphoto-miniprogram/src/core/suitFitV2'),
    ...require('../idphoto-miniprogram/src/core/suitTemplates'),
    ...require('../idphoto-miniprogram/src/core/suitDiff'),
    ...require('../idphoto-miniprogram/src/core/alphaPatch'),
    ...require('../idphoto-miniprogram/src/core/paperLibrary'),
    segment: async () => stop('segment'),
    applyBeauty: () => stop('beauty'),
    buildCloudFnAdapter: () => ({}),
    backendLabel: () => 'probe',
    withTimeout: (promise) => promise,
    ...options.services,
  };
  const jsx = (type, props) => typeof type === 'function' ? type(props || {}) : ({ type, props: props || {} });

  function load(file) {
    if (cache[file]) return cache[file];
    const source = fs.readFileSync(file, 'utf8');
    loaded[path.relative(ROOT, file)] = crypto.createHash('sha256').update(source).digest('hex');
    const code = compile(file);
    const exports = {};
    const localRequire = (request) => {
      if (request === 'react') return react;
      if (request === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (request === '@tarojs/taro') return { __esModule: true, default: taro };
      if (request === '@tarojs/components') return new Proxy({}, { get: (_, name) => String(name) });
      if (/\.(scss|png)$/.test(request)) return request;
      if (request.endsWith('/services') || request === '.') return services;
      if (request.endsWith('/services/pipeline') || request === './pipeline') return { prepareWorkCanvas: options.prepareWorkCanvas || (async () => ({
        w: 64, h: 80, rgba: new Uint8ClampedArray(64 * 80 * 4), canvas: canvas(),
        plan: { sx: 0, sy: 0, sw: 64, sh: 80 }, crop: null, srcMetrics: null,
      })) };
      if (request.endsWith('/services/suitAssets') || request === './suitAssets') return options.suitAssets || { researchTemplates: [{id:'research-white',name:'白色正装',src:'fixture-white.png'},{id:'research-navy',name:'深蓝正装',src:'fixture-navy.png'},{id:'research-black',name:'黑色正装',src:'fixture-black.png'}], loadResearchTemplate: async () => 'fixture-research.png' };
      if (request.endsWith('/services/poseService') || request === './poseService') return options.poseService || { requestPoseKeypoints: async () => stop('pose'), prepareSuitImage: (_canvas,width,height) => ({imageB64:null,width,height}) };
      if (request.endsWith('/services/clothingService') || request === './clothingService') return options.clothingService || { parseSuitClothing: async () => stop('clothing') };
      if (request.endsWith('/services/cloudClothingService') || request === './cloudClothingService') return options.cloudClothingService || { parseCloudSuitClothing: async () => stop('clothing') };
      if (request === './collarFitService') return options.collarFitService || {fitCloudCollar:async()=>stop('collar-fit')};
      if (request.endsWith('/core/suitCollarCompose') && options.suitCollarCompose) return options.suitCollarCompose;
      if (request.endsWith('/services/cloudFaceService') || request === './cloudFaceService') return options.cloudFaceService || { measureCloudSuitFace: async () => stop('cloud-face') };
      if (request.endsWith('/hooks/useImagePicker') && options.actualPicker) return load(path.resolve(path.dirname(file), request + '.tsx'));
      if (request.endsWith('/hooks/useImagePicker')) return { useImagePicker(onImage) {
        imageHandler = onImage;
        return { pickAlbum: () => { imageDelivered = true; return onImage({ path: 'probe://valid.png', width: 640, height: 800 }, { tips: [] }); } };
      } };
      if (request.endsWith('/MattingStatus')) return load(path.resolve(path.dirname(file), request, 'index.tsx'));
      if (request.endsWith('/components/PhotoTool')) return load(path.resolve(path.dirname(file), request, 'index.tsx'));
      if (request.includes('/components/') || request === '../BackgroundControl') return { __esModule: true, default: request.split('/').pop() };
      if (request.endsWith('/hooks/useConsentGate') || request.endsWith('/hooks/useProcessingSession') || request.endsWith('/hooks/useT1Workflow') || request.endsWith('/hooks/useActionConsent')) return load(path.resolve(path.dirname(file), request + '.ts'));
      if (request.includes('/core/') || request === '../services/imageSelection') {
        const name = path.basename(request); const modulePath = require.resolve('../idphoto-miniprogram/src/' + (request.includes('/core/') ? 'core/' : 'services/') + name);
        loaded[path.relative(ROOT, modulePath)] = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
        if (!['processingSession', 't1Workflow'].includes(name)) return require(modulePath);
      }
      if (request === './wechatInference') return require('../idphoto-miniprogram/src/services/wechatInference');
      if (request === './modelService') return load(path.resolve(ROOT, 'idphoto-miniprogram/src/services/modelService.ts'));
      if (request === './exportInspection' || request.endsWith('/services/exportInspection')) return load(path.resolve(ROOT, 'idphoto-miniprogram/src/services/exportInspection.ts'));
      if (request.endsWith('/services/t1Processing')) return load(path.resolve(path.dirname(file), request + '.ts'));
      if (request.endsWith('/core/t1Workflow')) {
        const modulePath = require.resolve('../idphoto-miniprogram/src/core/t1Workflow');
        loaded[path.relative(ROOT, modulePath)] = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
        const { createT1Workflow } = require(modulePath);
        return { createT1Workflow: (session, adapters, opts) => (observedFlow = createT1Workflow(session, adapters, opts)) };
      }
      if (request.endsWith('/core/processingSession')) {
        const modulePath = require.resolve('../idphoto-miniprogram/src/core/processingSession');
        loaded[path.relative(ROOT, modulePath)] = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
        const { createProcessingSession } = require(modulePath);
        return { createProcessingSession: (opts = {}) => (observedSession = createProcessingSession({ ...opts, logger() {} })) };
      }
      if (request.endsWith('/core/beauty')) return { applyBeauty: () => stop('beauty') };
      throw new Error('PROBE_IMPORT_UNSUPPORTED: ' + request);
    };
    const context = vm.createContext({ exports, require: localRequire, Uint8ClampedArray, Uint8Array, Float32Array,
      Promise, console: { log() {}, warn() {}, error() { runtimeErrors++; } }, queueMicrotask, setTimeout, clearTimeout });
    new vm.Script(code, { filename: path.relative(ROOT, file) }).runInContext(context, { timeout: 2000 });
    cache[file] = exports;
    return exports;
  }
  const component = load(path.join(ROOT, 'idphoto-miniprogram/src/pages', pages[tool], 'index.tsx')).default;
  const render = () => { cursor = 0; const tree = component(); while (effects.length) effects.shift()(); return tree; };
  function nodes(tree, predicate, found = []) {
    if (Array.isArray(tree)) tree.forEach((node) => nodes(node, predicate, found));
    else if (tree && typeof tree === 'object' && tree.props) {
      if (predicate(tree)) found.push(tree);
      nodes(tree.props.children, predicate, found);
    }
    return found;
  }
  let tree = render();
  // 授予当前页面要求的全部授权；这里只隔离检查选图后的控制流，不认领授权完整合规。
  let consents = nodes(tree, (node) => String(node.props.className || '').split(' ').includes('consent__item'));
  const count = consents.length;
  for (const i of options.consentIndices || Array.from({ length: count }, (_, i) => i)) {
    consents[i].props.onClick();
    tree = render();
    consents = nodes(tree, (node) => String(node.props.className || '').split(' ').includes('consent__item'));
  }
  const pick = nodes(tree, (node) => node.type === 'Button' && String(node.props.className || '').split(' ').includes('btn-primary'))[0];
  if (!pick || (!imageHandler && !options.actualPicker)) return { tool, status: 'BLOCKED', reason: '页面适配器未找到选图动作，不能算通过', loaded };
  if (!options.skipPick) await pick.props.onClick();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  let details;
  if (options.exercise) details = await options.exercise({ render, nodes, events, session: observedSession, flow: observedFlow, pick: () => imageHandler({ path: 'probe://next.png', width: 640, height: 800 }, { tips: [] }) });
  const observation = { imageDelivered, cropConfirmed: observedSession ? observedSession.getState().params.cropConfirmed : cropConfirmed, events };
  const sessionState = observedSession && observedSession.getState();
  for (const cancel of cleanup) cancel();
  if (runtimeErrors && !events.length) return { tool, status: 'BLOCKED', reason: '页面出现异常且无下游调用观测，不能算通过', observation, loaded };
  return { tool, ...beforeCropConfirmation(observation), observation, loaded, sessionState, details,
    environment: 'node-page-controller/mock-picker/mock-platform/mock-image-algorithm',
    limitations: '真实页面代码仅执行控制流；不验证微信渲染、图片质量、模型、网络或完整授权流程；不会读取/上传照片' };
}

module.exports = { probePage };
