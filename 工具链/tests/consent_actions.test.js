'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { probePage } = require('../page_flow_probe');
const { segment } = require('../../idphoto-miniprogram/src/core/matting');
const nodes = (h, predicate) => h.nodes(h.render(), predicate);
const button = (h, cls) => nodes(h, (n) => n.type === 'Button' && n.props.className === cls)[0];
const consents = (h) => nodes(h, (n) => String(n.props.className || '').split(' ').includes('consent__item'));
const hasScreen = (h, screen) => nodes(h, (n) => n.props.className === 'flow-screen screen-' + screen).length;
test('RC-06实际选图hook：T1/T2/T3/T4未本地授权，相册和相机零调用', async () => {
  for (const tool of ['T1','T2','T3','T4']) {
    let chooses = 0;
    await probePage(tool, { actualPicker: true, skipPick: true, consentIndices: [], taro: { chooseMedia: async () => { chooses++; } }, exercise: async (h) => {
      assert.equal(button(h,'btn-primary').props.disabled, true);
      await button(h,'btn-primary').props.onClick(); button(h,'btn-camera').props.onClick();
      const guide = nodes(h,(n)=>n.type==='CameraGuide')[0]; assert.equal(guide.props.visible,false);
      assert.equal(chooses,0);
    } });
  }
});
test('RC-06实际选图hook：仅本地可选；在相册回传前撤回再授权，旧照片不读不处理', async () => {
  for (const tool of ['T1','T2','T3','T4']) {
    let release; let reads = 0; let chooses = 0;
    await probePage(tool,{actualPicker:true,skipPick:true,consentIndices:[0],taro:{
      chooseMedia: () => { chooses++;return new Promise((resolve)=>{release=resolve;}); }, getImageInfo: async()=>{reads++;return {};} },exercise:async(h)=>{
      assert.equal(button(h,'btn-primary').props.disabled,false);
      const oldPick=button(h,'btn-primary').props.onClick; const pending=oldPick();
      consents(h)[0].props.onClick(); await oldPick(); assert.equal(chooses,1); consents(h)[0].props.onClick();
      release({tempFiles:[{tempFilePath:'fixture://old.jpg',size:100}]}); await pending;
      assert.equal(reads,0); assert.equal(h.events.length,0);
      if(tool==='T1') assert.equal(hasScreen(h,'upload'),1);
    }});
  }
});
test('RC-06实际相机hook：打开后撤回关闭预览，迟到拍摄不读取照片', async () => {
  let reads=0;
  await probePage('T1',{actualPicker:true,skipPick:true,consentIndices:[0],taro:{getImageInfo:async()=>{reads++;return {}; }},exercise:async(h)=>{
    button(h,'btn-camera').props.onClick(); const guide=nodes(h,(n)=>n.type==='CameraGuide')[0]; assert.equal(guide.props.visible,true);
    consents(h)[0].props.onClick(); assert.equal(nodes(h,(n)=>n.type==='CameraGuide')[0].props.visible,false);
    await guide.props.onCapture('fixture://late.jpg'); assert.equal(reads,0);
  }});
});
test('RC-06仅本地低置信抠图仍返回本地结果，不发出云请求且明确质量限制',async()=>{
  let calls=0; const rgba=new Uint8ClampedArray(32*32*4);
  for(let i=0;i<rgba.length;i++) rgba[i]=(i*73+17)%256;
  const r=await segment({rgba,width:32,height:32,consents:['faceLocal'],cloud:{adapter:{call:async()=>{calls++;}}}});
  assert.equal(calls,0); assert.ok(r.alpha); assert.equal(r.route,'cloud'); assert.equal(r.degraded,true);assert.equal(r.cloudError,'cloud_consent_missing');
});
test('RC-06 T1处理在途撤回，迟到工作画布不会抠图或提供成品',async()=>{
  let release; let segments=0;
  await probePage('T1',{consentIndices:[0], prepareWorkCanvas:async(input)=> input.cropWindow ? new Promise((resolve)=>{release=resolve;}) : {crop:null},
    services:{segment:async()=>{segments++;}},exercise:async(h)=>{
      nodes(h,n=>n.type==='CropStep')[0].props.onApplyCrop();
      const pending=nodes(h,n=>n.type==='BeautyStep')[0].props.onApply();
      await Promise.resolve();await Promise.resolve(); consents(h)[0].props.onClick();
      release({});await pending;await new Promise(resolve=>setImmediate(resolve));
      assert.equal(segments,0);assert.equal(hasScreen(h,'upload'),1);assert.equal(button(h,'flow-save'),undefined);
    }});
});
test('RC-06旧页面：T2/T3/T4在途授权变化后不继续处理、不恢复结果',async()=>{
  for(const tool of ['T2','T3','T4']) {
    let release;let segments=0;let faces=0;
    await probePage(tool,{skipPick:true,consentIndices:[0],
      prepareWorkCanvas:()=>new Promise(resolve=>{release=resolve;}),
      services:{segment:async()=>{segments++;throw new Error('unexpected');},measureHeadRatio:async()=>{faces++;return {}; }},
      taro:{getFileInfo:()=>new Promise(resolve=>{release=resolve;})},exercise:async(h)=>{
        const pending=h.pick();await Promise.resolve();await Promise.resolve();
        const index=tool==='T4'?0:1;
        consents(h)[index].props.onClick();consents(h)[index].props.onClick();
        release({size:1024});await pending;
        assert.equal(segments,0);assert.equal(faces,0);
        assert.equal(nodes(h,n=>n.type==='Image'&&n.props.className==='preview').length,0);
      }});
  }
});
test('RC-06 T5/T6实际页面与选图hook不强加人脸授权',async()=>{
  for(const tool of ['T5','T6']) {
    let calls=0;
    await probePage(tool,{actualPicker:true,skipPick:true,consentIndices:[],taro:{chooseMedia:async()=>{calls++;throw {errMsg:'cancel'};}},exercise:async(h)=>{
      assert.equal(consents(h).length,0);await button(h,'btn-primary').props.onClick();assert.equal(calls,1);
    }});
  }
});
test('RC-06 T3仅本地授权可以取图，换装动作须独立同意，拒绝时零抠图',async()=>{
  let segments=0;
  await probePage('T3',{consentIndices:[0],services:{segment:async()=>{segments++;}},exercise:async(h)=>{
    assert.equal(h.flow.getState().screen,'crop');assert.equal(segments,0);
    nodes(h,n=>n.type==='CropStep')[0].props.onApplyCrop();
    // 换装授权由后续独立步骤取得，选图与裁剪不依赖它。
    assert.equal(h.flow.getState().screen,'beauty');assert.equal((await h.flow.applySuit()).ok,false);
  }});
});
test('RC-06撤回后质量评估提示也不能继续显示或在重新授权时复活',async()=>{
  for(const tool of ['T1','T2','T3','T4']) await probePage(tool,{actualPicker:true,consentIndices:[0],taro:{
    chooseMedia:async()=>({tempFiles:[{tempFilePath:'fixture://photo.jpg',size:1024}]}),
    getImageInfo:async()=>({width:640,height:800,type:'jpg'}),
  },exercise:async(h)=>{
    const quality=()=>nodes(h,n=>n.type==='QualityTip')[0]?.props.quality ?? null;
    assert.ok(quality(),'已授权的本次评估应可显示');
    consents(h)[0].props.onClick();assert.equal(quality(),null,'撤回后不显示旧质量结果');
    consents(h)[0].props.onClick();assert.equal(quality(),null,'重新同意不恢复旧质量结果');
  }});
});
test('RC-06质量采样迟到，撤回再同意也不能回写或进入处理',async()=>{
  let release;let samples=0;
  await probePage('T3',{actualPicker:true,skipPick:true,consentIndices:[0],taro:{
    chooseMedia:async()=>({tempFiles:[{tempFilePath:'fixture://late.jpg',size:1024}]}),
    getImageInfo:async()=>({width:640,height:800,type:'jpg'}),
    createOffscreenCanvas:()=>({getContext:()=>({drawImage(){},getImageData(){samples++;return {data:new Uint8ClampedArray(64*64*4)};}}),
      createImage(){const img={};Object.defineProperty(img,'src',{set(){release=()=>img.onload();}});return img;}}),
  },exercise:async(h)=>{
    const pending=button(h,'btn-primary').props.onClick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof release,'function');consents(h)[0].props.onClick();consents(h)[0].props.onClick();
    release();await pending;assert.equal(samples,0,'撤回后不再读取迟到图像像素');
    assert.equal(nodes(h,n=>n.type==='QualityTip')[0]?.props.quality ?? null,null);assert.equal(h.events.length,0);
  }});
});
