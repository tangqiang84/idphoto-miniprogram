'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {probePage}=require('../page_flow_probe');
const nodes=(h,p)=>h.nodes(h.render(),p);
const component=(h,name)=>nodes(h,n=>n.type===name)[0];
const button=(h,name)=>nodes(h,n=>n.type==='Button'&&n.props.className===name)[0];
function fixture(){
 const f={prepare:0,segment:0,beauty:0,save:[],files:new Map(),renders:[],pixels:[]};
 f.options={prepareWorkCanvas:async()=>{f.prepare++;return {w:64,h:80,rgba:new Uint8ClampedArray(64*80*4),plan:{sx:0,sy:0,sw:64,sh:80},crop:null,srcMetrics:null};},
 services:{segment:async()=>{f.segment++;return {alpha:new Float32Array(64*80),backend:'fixture'};},applyBeauty:()=>{f.beauty++;},
  tightBBox:()=>({}),measureHeadMetrics:async()=>({ok:true,headLengthPx:20,source:'estimate',metrics:{chinY:30,crownY:10,faceCenterX:32}}),
  checkComposition:()=>({ok:true}),fitSuitV2:()=>({ok:true,place:{},rotateDeg:0,audit:{source:'fixture'}}),suitCompose:rgba=>rgba},
 taro:{createOffscreenCanvas:({width,height})=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(width*height*4)}),putImageData(d){f.pixels.push(Array.from(d.data));}}),
   createImage(){const img={};Object.defineProperty(img,'src',{set(){queueMicrotask(()=>img.onload());}});return img;}}),
  canvasToTempFilePath:async(p)=>{const path='fixture://'+f.renders.length;f.renders.push(p);f.files.set(path,{width:p.destWidth,height:p.destHeight,type:p.fileType});return {tempFilePath:path};},
  getImageInfo:async({src})=>f.files.get(src),getFileSystemManager:()=>({getFileInfo:({success})=>success({size:40*1024})}),
  saveImageToPhotosAlbum:async({filePath})=>f.save.push(filePath),navigateTo:async()=>{},}};return f;
}
async function precheck(h){component(h,'CropStep').props.onApplyCrop();await button(h,'flow-skip-beauty').props.onClick();button(h,'flow-next-dress').props.onClick();}
async function finalize(h){component(h,'MirrorCheck').props.onChange(true);await button(h,'flow-confirm-dpi').props.onClick();}
test('RC-07实际T2页面：规格必选，裁剪/美颜后处理，无换装；HEX/RGB/渐变/透明输出角色正确',async()=>{
 const f=fixture();await probePage('T2',{...f.options,exercise:async(h)=>{
  assert.equal(f.segment,0);component(h,'CropStep').props.onApplyCrop();assert.equal(f.segment,0);
  await button(h,'flow-skip-beauty').props.onClick();assert.equal(f.segment,1);
  await h.flow.background('#438EDB');const hex=f.pixels.at(-1);
  await h.flow.background('67,142,219');assert.deepEqual(f.pixels.at(-1),hex);
  assert.equal((await h.flow.background('300,0,0')).ok,false,'非法RGB不能静默截断');
  await h.flow.background({type:'gradient',from:'#000000',to:'#FFFFFF',angle:0});
  const gradient=f.pixels.at(-1);assert.ok(gradient[0]<gradient[63*4]);
  await h.flow.background(null);assert.equal(f.renders.at(-1).fileType,'png');assert.equal(f.pixels.at(-1)[3],0);
  button(h,'flow-next-dress').props.onClick();assert.equal(h.flow.getState().screen,'check');assert.equal(button(h,'flow-apply-suit'),undefined);
  button(h,'flow-next-dpi').props.onClick();await finalize(h);assert.equal(h.flow.getState().screen,'export');
  assert.equal(h.flow.getState().finalResult.colorRisk,true);assert.equal(h.flow.getState().finalResult.fileType,'png');
  await button(h,'flow-save').props.onClick();assert.equal(f.save.length,1);
 }});
});
test('RC-07实际T3页面：九规格、无跳过按钮，换装预览与最终文件都须当前自检',async()=>{
 const f=fixture();await probePage('T3',{...f.options,exercise:async(h)=>{
  assert.equal(f.segment,0);await precheck(h);assert.equal(button(h,'flow-skip-suit'),undefined);
  assert.equal((await h.flow.skipSuit()).ok,false);assert.equal((await h.flow.applySuit()).ok,false);
  nodes(h,n=>n.props.className==='suit-consent')[0].props.onClick();await button(h,'flow-apply-suit').props.onClick();
  assert.equal(h.flow.getState().pendingSelf,true);assert.equal(h.flow.acceptSelfCheck().ok,false);
  h.flow.confirmSelfCheck(true);h.flow.acceptSelfCheck();button(h,'flow-next-dpi').props.onClick();
  component(h,'DpiStep').props.onChange(600);h.flow.back();assert.equal(h.flow.goDpi().ok,true,'仅改档位后返回预审可继续，最终新文件仍重新自检');
  await finalize(h);
  assert.equal(button(h,'flow-save'),undefined);h.flow.confirmSelfCheck(true);h.flow.acceptSelfCheck();
  await button(h,'flow-save').props.onClick();assert.equal(f.save.length,1);
 }});
});
test('RC-07实际T5页面：确认裁剪后档位，修改自定义与KB保参，整个链路零人脸算法',async()=>{
 const f=fixture();await probePage('T5',{...f.options,exercise:async(h)=>{
  component(h,'CropStep').props.onCropWindowChange({x:40,y:50,w:300,h:420});
  component(h,'CropStep').props.onApplyCrop();assert.equal(h.flow.getState().screen,'dpi');
  component(h,'DpiStep').props.onChange(600);await finalize(h);assert.equal(h.flow.getState().screen,'export');
  assert.equal(h.flow.getState().finalResult.width,591);assert.equal(h.flow.getState().finalResult.height,827);
  assert.equal(f.prepare,0);assert.equal(f.segment,0);assert.equal(f.beauty,0);
  const old=button(h,'flow-save').props.onClick;h.flow.back();h.flow.back();h.flow.back();
  assert.equal(h.flow.getState().screen,'upload');component(h,'Input').props.onInput({detail:{value:'320'}});
  nodes(h,n=>n.props.className==='custom-height')[0].props.onInput({detail:{value:'480'}});button(h,'custom-apply').props.onClick();
  component(h,'CropStep').props.onApplyCrop();h.flow.update({kbLimit:0});await finalize(h);
  assert.equal(h.flow.getState().finalResult.width,320);assert.equal(h.flow.getState().finalResult.height,480);
  await old();assert.equal(f.save.length,0);await button(h,'flow-save').props.onClick();assert.equal(f.save.length,1);
 }});
});
test('RC-07 T4隔离回归：只读原图出检测报告，不生成或保存图片',async()=>{
 const f=fixture();f.options.services.measureHeadRatio=async()=>({ok:false,source:'unavailable',notes:[]});
 f.options.taro.getFileInfo=async()=>({size:40*1024});
 await probePage('T4',{...f.options,exercise:async(h)=>{
  assert.equal(f.renders.length,0);assert.equal(f.save.length,0);assert.equal(f.segment,0);assert.equal(f.beauty,0);
  assert.ok(nodes(h,n=>n.type==='Image'&&n.props.src==='probe://valid.png').length);
 }});
});
test('RC-07 T6隔离回归：独立无脸授权拼版，实际调用输出固定相纸几何',async()=>{
 const f=fixture();
 f.options.taro.createOffscreenCanvas=({width,height})=>({getContext:()=>new Proxy({getImageData:()=>({data:new Uint8ClampedArray(width*height*4)})},{get:(o,k)=>o[k]||(()=>{})}),createImage(){const img={};Object.defineProperty(img,'src',{set(){queueMicrotask(()=>img.onload());}});return img;}});
 await probePage('T6',{...f.options,exercise:async(h)=>{
  h.render();await new Promise(resolve=>setImmediate(resolve));h.render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.segment,0);assert.equal(f.beauty,0);assert.equal(f.prepare,0);assert.ok(f.renders.length>0);
  // 已确认相纸表以152×102mm为基准，300档舍入为1795×1205，不以6×4英寸另算。
  assert.equal(f.renders.at(-1).destWidth,1795);assert.equal(f.renders.at(-1).destHeight,1205);
 }});
});
