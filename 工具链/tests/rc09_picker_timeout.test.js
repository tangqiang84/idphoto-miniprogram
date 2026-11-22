'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('../../idphoto-miniprogram/node_modules/typescript');
const actual=require('../../idphoto-miniprogram/src/core/asyncUtils');
function load(){let draws=0,expired=false,deadlineCalls=0,image;const taro={createOffscreenCanvas:()=>({getContext:()=>({drawImage(){draws++;},getImageData:()=>({data:new Uint8ClampedArray(4)})}),createImage:()=>{image={};return image;}})};const exports={};
 const source=fs.readFileSync('idphoto-miniprogram/src/hooks/useImagePicker.tsx','utf8')+'\nexports.samplePixels=samplePixels;exports.getFileSizeBytes=getFileSizeBytes;';
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new vm.Script(code).runInNewContext({exports,Uint8ClampedArray,require(n){if(n==='@tarojs/taro')return{__esModule:true,default:taro};if(n.endsWith('/asyncUtils'))return{...actual,withTimeout(p,ms,c){assert.equal(ms,15000);deadlineCalls++;return actual.withTimeout(p,5,c);}};return{};}});
 return{...exports,state:()=>({draws,expired,deadlineCalls}),late:()=>{expired=true;image.onload();}};
}
async function bounded(p){return Promise.race([p,new Promise(r=>setTimeout(()=>r('HUNG'),100))]);}
test('取图质量采样无回调必须有界返回，迟到图片不能再读像素',async()=>{const x=load();assert.equal(await bounded(x.samplePixels('fixture',{current:()=>true})),null);x.late();await new Promise(r=>setImmediate(r));assert.equal(x.state().draws,0);assert.equal(x.state().deadlineCalls,1);});
test('文件信息无回调有界降级，已有字节数不请求SDK',async()=>{const x=load();let calls=0;const t={getFileSystemManager:()=>({getFileInfo(){calls++;}})};assert.equal(await bounded(x.getFileSizeBytes(t,'fixture')), -1);assert.equal(await x.getFileSizeBytes(t,'fixture',123),123);assert.equal(calls,1);});
