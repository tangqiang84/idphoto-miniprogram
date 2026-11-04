'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('vm');const path=require('path');const ts=require('../../idphoto-miniprogram/node_modules/typescript');
const file=path.resolve(__dirname,'../../idphoto-miniprogram/src/components/DpiStep/index.tsx');
function render(props){const exports={};const jsx=(type,props)=>({type,props});const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const context=vm.createContext({exports,require:n=>{if(n==='react/jsx-runtime')return {jsx,jsxs:jsx};if(n==='@tarojs/components')return new Proxy({},{get:(_,k)=>k});if(n.endsWith('.scss'))return {};if(n.includes('/core/'))return require('../../idphoto-miniprogram/src/core/'+n.split('/').pop());throw Error(n);}});new vm.Script(code).runInContext(context);return exports.default({specId:'one-inch',specName:'一寸',dpi:600,onChange(){},...props});}
function text(n){if(Array.isArray(n))return n.map(text).join('');if(n?.props)return text(n.props.children);return typeof n==='string'||typeof n==='number'?String(n):'';}
test('RC-08实际档位组件：大原图小裁剪必警告，已放大工作图或缺失裁剪证据不能误报满足',()=>{
 for(const p of [{effectiveW:300,effectiveH:420},{}]){const t=text(render({srcW:6000,srcH:8000,workW:1600,workH:2200,...p}));assert.doesNotMatch(t,/原图有效裁剪像素满足/);assert.match(t,/像素不足|无法确认/);}
 assert.match(text(render({effectiveW:1200,effectiveH:1600,processingW:300,processingH:420})),/当前处理分辨率不足/);
 assert.match(text(render({effectiveW:1200,effectiveH:1600})),/原图有效裁剪像素满足/);
});
test('RC-08实际档位组件：自定义固定像素也评估清晰度，档位不冒充元数据实测',()=>{
 const t=text(render({effectiveW:300,effectiveH:420,customTarget:{width:1000,height:1400}}));assert.match(t,/自定义固定像素/);assert.match(t,/原图有效裁剪像素不足/);assert.match(t,/不承诺文件dpi元数据/);assert.doesNotMatch(t,/成品为实拍像素/);
});
