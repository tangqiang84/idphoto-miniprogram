'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ts = require('../../idphoto-miniprogram/node_modules/typescript');
const file = path.resolve(__dirname, '../../idphoto-miniprogram/src/components/CropStep/index.tsx');
function mount() {
  const slots = []; let cursor = 0;
  const react = { useMemo: (fn) => fn(), useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = initial; return [slots[id], (value) => { slots[id] = value; }]; } };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = vm.createContext({ exports, require: (name) => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === '@tarojs/components') return new Proxy({}, { get: (_, key) => String(key) });
    if (name === '@tarojs/taro') return { __esModule: true, default: { getSystemInfoSync: () => ({ windowWidth: 375 }) } };
    if (name.endsWith('/core/cropWindow')) return require('../../idphoto-miniprogram/src/core/cropWindow');
    if (name.endsWith('.scss')) return {};
    throw new Error('Unsupported import');
  } });
  new vm.Script(code).runInContext(context, { timeout: 2000 });
  let crop = { x: 0, y: 0, w: 1000, h: 1400 }; let updates = 0;
  function nodes(node, type, result = []) { if (Array.isArray(node)) node.forEach((n) => nodes(n, type, result)); else if (node?.props) { if (node.type === type) result.push(node); nodes(node.props.children, type, result); } return result; }
  const render = () => { cursor = 0; return exports.default({ confirmationRequired: true, specName: 'fixture', target: { width: 500, height: 700 }, imageSrc: 'fixture://image', srcW: 1000, srcH: 1400, cropWindow: crop,
    onCropWindowChange(next) { updates++; crop = next; } }); };
  return { render, nodes, crop: () => crop, updates: () => updates };
}
test('T1裁剪缩放是绝对比例，连续80%不复合缩小，拖动回写同一原图窗', () => {
  const h = mount();
  h.nodes(h.render(), 'Slider')[0].props.onChange({ detail: { value: 80 } });
  assert.equal(h.crop().w, 800);
  h.nodes(h.render(), 'Slider')[0].props.onChange({ detail: { value: 80 } });
  assert.equal(h.crop().w, 800, '重复80%不能再缩为640');
  const box = h.nodes(h.render(), 'MovableView')[0];
  const previous = { ...h.crop() };
  box.props.onChange({ detail: { x: box.props.x + 10, y: box.props.y + 20, source: 'touch' } });
  assert.ok(Math.abs(h.crop().x - (previous.x + 10 / 0.303)) < 2);
  assert.ok(Math.abs(h.crop().y - (previous.y + 20 / 0.303)) < 2);
});
test('T1程序化定位事件不冒充用户拖动或覆盖待确认裁剪', () => {
  const h = mount(); const box = h.nodes(h.render(), 'MovableView')[0];
  box.props.onChange({ detail: { x: 0, y: 0, source: '' } });
  assert.equal(h.updates(), 0);
});
