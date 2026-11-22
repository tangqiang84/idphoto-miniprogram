'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {probePage}=require('../page_flow_probe');
const flatten=n=>Array.isArray(n)?n.map(flatten).join(''):n?.props?flatten(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'';
function fixture(){const f={draw:[],rotations:[],files:new Map(),failType:false};f.options={taro:{createOffscreenCanvas:({width,height})=>({getContext:()=>new Proxy({drawImage:(...args)=>f.draw.push(args),rotate:v=>f.rotations.push(v)},{get:(o,k)=>o[k]||(()=>{})}),createImage(){const img={};Object.defineProperty(img,'src',{set(){queueMicrotask(()=>img.onload());}});return img;}}),canvasToTempFilePath:async(p)=>{const path='fixture://'+f.files.size;f.files.set(path,{width:p.destWidth,height:p.destHeight,type:f.failType?'png':'jpeg'});return {tempFilePath:path};},getImageInfo:async({src})=>f.files.get(src),getFileSystemManager:()=>({getFileInfo:({success})=>success({size:123456})})}};return f;}
async function settle(h){for(let i=0;i<5;i++){h.render();await new Promise(r=>setImmediate(r));}}
function choose(h,label){h.nodes(h.render(),n=>String(n.props.className).includes('spec-chip')&&flatten(n)===label)[0].props.onClick();}
test('RC-08实际T6旋转相纸后源裁剪比例保持，纸张按真实落盘值核验',async()=>{const f=fixture();await probePage('T6',{...f.options,exercise:async h=>{await settle(h);choose(h,'二寸 35×49mm');await settle(h);assert.ok([...f.files.values()].some(v=>v.width===1205&&v.height===1795),'6寸二寸实际最优方案旋转整纸');const last=f.draw.at(-1);assert.ok(Math.abs(last[3]/last[4]-35/49)<0.01,'源裁剪应保持未旋转照片比例');assert.ok(h.nodes(h.render(),n=>n.type==='Image'&&n.props.className==='preview preview--tall').length);}});});
test('RC-08 T6文件格式不符不提供预览保存；不可拼版美签不生成废图',async()=>{const f=fixture();await probePage('T6',{...f.options,exercise:async h=>{await settle(h);const before=f.files.size;choose(h,'美国签证 50.8×50.8mm');await settle(h);choose(h,'instax mini（每版1张）');await settle(h);assert.match(flatten(h.render()),/无法容纳/);assert.equal(h.nodes(h.render(),n=>n.type==='Image').length,0);assert.equal(f.files.size,before+1);f.failType=true;choose(h,'6寸(4R)');await settle(h);assert.equal(h.nodes(h.render(),n=>n.type==='Image').length,0);assert.match(flatten(h.render()),/PRINT_EXPORT_FAILED/);}});});

test('RC-11 切换相纸时旧加载回调不会启动导出',async()=>{
 const f=fixture();
 const callbacks=[];
 const create=f.options.taro.createOffscreenCanvas;
 f.options.taro.createOffscreenCanvas=params=>{
  const canvas=create(params);
  canvas.createImage=()=>{
   const image={};
   Object.defineProperty(image,'src',{set(){callbacks.push(()=>image.onload());}});
   return image;
  };
  return canvas;
 };
 await probePage('T6',{...f.options,exercise:async h=>{
  await settle(h);
  assert.equal(callbacks.length,1);
  choose(h,'二寸 35×49mm');
  await settle(h);
  assert.equal(callbacks.length,2);
  callbacks[0]();
  await settle(h);
  assert.equal(f.files.size,0);
  callbacks[1]();
  await settle(h);
  assert.equal(f.files.size,1);
 }});
});
