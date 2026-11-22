'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {probePage}=require('../page_flow_probe');
const {TEMPLATE_META}=require('../../idphoto-miniprogram/src/core/suitFitV2');
const {composeCollarSuit}=require('../../idphoto-miniprogram/src/core/suitCollarCompose');
const component=(h,name)=>h.nodes(h.render(),n=>n.type===name)[0];
const node=(h,name)=>h.nodes(h.render(),n=>n.props.className===name)[0];
async function dress(h){h.flow.update({suit:{enabled:false,templateId:'black'}});h.flow.confirmCrop();await h.flow.confirmBeauty(true);h.flow.nextDress();}
function fixture({approved=false,tamper=false,faceCount=1,pose=true,shoulderY=67.2}={}){
 const f={segments:0,poses:0,composes:0,loads:0,files:new Map()};
 f.options={collarFitService:{fitCloudCollar:async()=>({geometry:{left:2,top:59,scale:.15,scaleX:.15,protectY:260,templateWidth:400,templateHeight:400},evidence:{provider:'synthetic-collar-fixture'}})},suitCollarCompose:{composeCollarSuit(p){f.composes++;const out=composeCollarSuit(p);if(tamper)out.rgba[(20*64+25)*4]--;return out;}},cloudClothingService:{parseCloudSuitClothing:async()=>({clothing:new Uint8Array(5120).fill(1),background:new Uint8Array(5120),evidence:{provider:'synthetic-mask-fixture'}})},prepareWorkCanvas:async()=>({w:64,h:80,rgba:new Uint8ClampedArray(64*80*4).fill(230),canvas:{},plan:{sx:0,sy:0,sw:64,sh:80},crop:null,srcMetrics:null}),
 poseService:{prepareSuitImage:(_canvas,width,height)=> ({imageB64:'SYNTHETIC-NOT-A-PHOTO',width,height}),requestPoseKeypoints:async()=>{f.poses++;return {ok:pose,reason:pose?null:'fixture:no_pose',pose:pose?{points:[{name:'left_shoulder',x:8,y:shoulderY,score:.9},{name:'right_shoulder',x:56,y:shoulderY,score:.9}]}:null};}},
 services:{segment:async()=>{f.segments++;return {alpha:new Float32Array(5120).fill(1),backend:'fixture'};},applyBeauty(){},tightBBox:()=>({x:0,y:0,w:64,h:80}),
 measureHeadMetrics:async()=>({ok:true,source:'landmarks',headLengthPx:52,faceCount,faceRect:{x:21,y:16,w:22,h:42},metrics:{quality:'good',crownY:6.4,chinY:58.4,faceCenterX:32}})},
 taro:{createOffscreenCanvas:({width,height})=>({getContext:()=>({drawImage(){},putImageData(){},getImageData:()=>({data:new Uint8ClampedArray(width*height*4).fill(100)})}),createImage(){f.loads++;const img={};Object.defineProperty(img,'src',{set(){queueMicrotask(()=>img.onload());}});return img;}}),
 canvasToTempFilePath:async p=>{const path='fixture://'+f.files.size;f.files.set(path,{width:p.destWidth,height:p.destHeight,type:p.fileType});return {tempFilePath:path};},getImageInfo:async({src})=>f.files.get(src),getFileSystemManager:()=>({getFileInfo:({success})=>success({size:61440})})}};
 // 仅测试接线：伪批准记录不进入生产目录，也不作为素材质量证据。
 f.options.cloudFaceService={measureCloudSuitFace:async (_image,_w,_h,auth)=>{
  auth.check();
  return {...await f.options.services.measureHeadMetrics(),provider:'mediapipe-face-landmarker-cpu',
   facePoints:Array.from({length:478},(_,i)=>[
    {x:22,y:17},{x:42,y:17},{x:42,y:57},{x:22,y:57},
   ][i%4]).map((point,i)=>i===61||i===291?{x:32,y:47}:point)};
 }};
 if(approved)f.options.services.getSuitTemplateStatus=()=>({ok:true,template:{native:{width:400,height:400},geometry:TEMPLATE_META}});
 return f;
}
test('RC-10生产模板门禁：T1/T3在授权前拒绝；零新增抠图/姿态/模板/合成，T3不能跳过导出',async()=>{
 for(const tool of ['T1','T3']){const f=fixture();await probePage(tool,{...f.options,exercise:async h=>{await dress(h);const before=f.segments;assert.ok(node(h,'suit-unavailable'));assert.equal(node(h,'suit-consent'),undefined);assert.equal(node(h,'flow-apply-suit').props.disabled,true);const r=await h.flow.applySuit();assert.equal(h.flow.getState().error.code,'suit:template_unapproved');assert.equal(f.segments,before);assert.equal(f.poses,0);assert.equal(f.loads,0);assert.equal(f.composes,0);assert.equal(h.session.getState().params.suit.enabled,false);if(tool==='T3'){assert.equal(node(h,'flow-skip-suit'),undefined);assert.equal((await h.flow.skipSuit()).ok,false);assert.equal(h.flow.goDpi().ok,false);}else assert.equal((await h.flow.skipSuit()).ok,true);}});}
});
test('RC-10合成接线：T1/T3同输入同实测/零脸差分；最终重生成必须再次自检',async()=>{
 const evidence=[];for(const tool of ['T1','T3']){const f=fixture({approved:true});await probePage(tool,{...f.options,exercise:async h=>{await dress(h);node(h,'suit-consent').props.onClick();assert.equal((await h.flow.applySuit()).ok,true);let s=h.flow.getState();assert.equal(s.preview.suitApplied,true);assert.equal(s.pendingSelf,true);const e=s.preview.suitEvidence;assert.equal(e.source,'collar');assert.equal(e.geometrySource,'visible-neck-opening-cpu');assert.equal(e.measuredShoulders,true);assert.equal(e.shoulderAngleDeg,0);assert.equal(e.faceDiff.checked,true);assert.equal(e.faceDiff.maxDiff,0);assert.equal(e.protectedChanged,0);assert.equal(e.qualityReview,'not-reviewed');evidence.push(JSON.stringify(e));h.flow.confirmSelfCheck(true);h.flow.acceptSelfCheck();assert.equal(h.flow.goDpi().ok,true);h.flow.confirmMirror(true);await h.flow.export();s=h.flow.getState();assert.equal(s.pendingSelf,true);assert.equal(h.flow.exportResult(h.flow.getState().finalResult.traceId).ok,false);h.flow.confirmSelfCheck(true);h.flow.acceptSelfCheck();assert.equal(h.flow.exportResult(h.flow.getState().finalResult.traceId).ok,true);}});}assert.equal(evidence[0],evidence[1]);
});
test('RC-10脸部仅1级变化也拒绝，不用旧24级阈值放行',async()=>{const f=fixture({approved:true,tamper:true});await probePage('T3',{...f.options,exercise:async h=>{await dress(h);node(h,'suit-consent').props.onClick();assert.equal((await h.flow.applySuit()).ok,false);const s=h.flow.getState();assert.equal(s.preview.suitApplied,false);assert.equal(s.preview.suitEvidence.reason,'suit:face_changed');assert.equal(s.preview.suitEvidence.faceDiff.maxDiff,1);assert.equal(h.flow.goDpi().ok,false);}});});
test('RC-10缺姿态、多人及未知脸数均不调用合成器',async()=>{for(const input of [{pose:false},{faceCount:2},{faceCount:null}]){const f=fixture({approved:true,...input});await probePage('T3',{...f.options,exercise:async h=>{await dress(h);node(h,'suit-consent').props.onClick();assert.equal((await h.flow.applySuit()).ok,false);assert.equal(f.composes,0);assert.equal(h.flow.goDpi().ok,false);}});}});
test('RC-10研究模板真实目录接入T1/T3，换模板使结果和自检失效',async()=>{
 for(const tool of ['T1','T3']){const f=fixture({shoulderY:72});let loads=0;
  f.options.suitAssets={researchTemplates:[{id:'research-white',name:'白色正装',src:'fixture-white.png'},{id:'research-navy',name:'深蓝正装',src:'fixture-navy.png'}],loadResearchTemplate:async(template,auth)=>{auth.check();loads++;assert.equal(template.usage,'research-only');return 'fixture-research.png';}};
  await probePage(tool,{...f.options,exercise:async h=>{
   await dress(h);h.flow.update({suit:{enabled:false,templateId:'research-white'}});
   assert.equal(node(h,'suit-unavailable'),undefined);assert.ok(node(h,'suit-consent'));
   assert.equal((await h.flow.applySuit()).ok,false);assert.equal(loads,0);
   node(h,'suit-consent').props.onClick();assert.equal((await h.flow.applySuit()).ok,true);
   assert.equal(loads,1);assert.equal(h.flow.getState().preview.suitEvidence.templateUsage,'research-only');assert.equal(h.flow.getState().preview.suitEvidence.pixelProtectionPassed,true);
   h.flow.confirmSelfCheck(true);h.flow.acceptSelfCheck();
   h.flow.update({suit:{enabled:true,templateId:'research-navy'}});
   assert.equal(h.session.getState().selfChecked,false);assert.equal(h.flow.getState().preview,null);
  }});
 }
});

test('RC-10领口服务拒绝时T3不合成不允许导出，肩峰旧算法反例仍由核心测试保留',async()=>{const f=fixture();f.options.collarFitService={fitCloudCollar:async()=>{throw {code:'SUIT_COLLAR_UNSUPPORTED',message:'领口不匹配'}}};await probePage('T3',{...f.options,exercise:async h=>{await dress(h);h.flow.update({suit:{enabled:false,templateId:'research-white'}});node(h,'suit-consent').props.onClick();assert.equal((await h.flow.applySuit()).ok,false);assert.equal(f.composes,0);assert.equal(h.flow.goDpi().ok,false);}});});

test('RC-10云解析在途更换模板：T1/T3丢弃旧结果且不再加载模板或合成',async()=>{
 for(const tool of ['T1','T3']){
  const f=fixture({approved:true});let finish,entered;const started=new Promise(r=>{entered=r;});
  f.options.cloudClothingService={parseCloudSuitClothing:async(_image,_w,_h,auth)=>{auth.check();entered();return new Promise(resolve=>{finish=()=>resolve({clothing:new Uint8Array(5120).fill(1),background:new Uint8Array(5120),evidence:{provider:'synthetic-delayed-cloud'}});});}};
  await probePage(tool,{...f.options,exercise:async h=>{
   await dress(h);node(h,'suit-consent').props.onClick();const pending=h.flow.applySuit();await started;
   const loads=f.loads,composes=f.composes;
   h.flow.update({suit:{enabled:true,templateId:'research-white'}});finish();
   const result=await pending;assert.equal(result.ok,false);assert.equal(f.loads,loads);assert.equal(f.composes,composes);
   assert.equal(h.flow.getState().preview,null);assert.equal(h.session.getState().selfChecked,false);
  }});
 }
});

test('RC-10端侧人脸优先；仅缺可靠单脸时走授权云后备，已检出多人不重检',async()=>{
 for(const tool of ['T1','T3'])for(const mode of ['device','missing','multiple']){
  const f=fixture({approved:true,faceCount:mode==='multiple'?2:1});let calls=0;
  const good=f.options.services.measureHeadMetrics;
  if(mode==='missing')f.options.services.measureHeadMetrics=async()=>({ok:false,source:'none',faceCount:null,metrics:null});
  f.options.cloudFaceService={measureCloudSuitFace:async(image,w,h,auth)=>{auth.check();assert.ok(image);assert.equal(w,64);assert.equal(h,80);calls++;return {...await good(),provider:'synthetic-cloud-face',rectSource:'landmark-envelope'};}};
  await probePage(tool,{...f.options,exercise:async h=>{await dress(h);node(h,'suit-consent').props.onClick();const r=await h.flow.applySuit();assert.equal(r.ok,mode!=='multiple');assert.equal(calls,mode==='missing'?1:0);if(mode==='missing')assert.equal(h.flow.getState().preview.suitEvidence.faceProvider,'synthetic-cloud-face');if(mode==='multiple')assert.equal(f.composes,0);}});
 }
});
test('RC-10领口拟合在途修改模板，T1/T3不能合成或保留旧预览',async()=>{
 for(const tool of ['T1','T3']){const f=fixture({approved:true});let finish,entered;const started=new Promise(r=>entered=r);
 f.options.collarFitService={fitCloudCollar:async()=>{entered();return new Promise(resolve=>finish=()=>resolve({geometry:{left:2,top:59,scale:.15,scaleX:.15,protectY:260,templateWidth:400,templateHeight:400},evidence:{provider:'delayed-fixture'}}));}};
 await probePage(tool,{...f.options,exercise:async h=>{await dress(h);node(h,'suit-consent').props.onClick();const pending=h.flow.applySuit();await started;h.flow.update({suit:{enabled:true,templateId:'research-white'}});finish();assert.equal((await pending).ok,false);assert.equal(f.composes,0);assert.equal(h.flow.getState().preview,null);}});
 }
});

test('RC-10 换装 JPEG 低于规格下限时提高编码质量', async () => {
 for (const tool of ['T1', 'T3']) {
  const f = fixture({approved:true});
  const qualities = [];
  const encode = f.options.taro.canvasToTempFilePath;
  f.options.taro.canvasToTempFilePath = async params => {
   qualities.push(params.quality);
   return encode(params);
  };
  f.options.taro.getFileSystemManager = () => ({
   getFileInfo: ({success}) => success({size: qualities.at(-1) === .95 ? 1024 : 61440}),
  });
  await probePage(tool, {...f.options, exercise: async h => {
   await dress(h);
   qualities.length = 0;
   node(h,'suit-consent').props.onClick();
   assert.equal((await h.flow.applySuit()).ok, true);
   assert.deepEqual(qualities, [.95, .97]);
  }});
 }
});

test('RC-10 研究模板只用已验证的嘴角坐标拟合，来源缺失时停止', async () => {
 for (const tool of ['T1','T3']) for (const available of [true,false]) {
  const f=fixture(); let cloudCalls=0, collarCalls=0;
  const measure=f.options.cloudFaceService.measureCloudSuitFace;
  const fit=f.options.collarFitService.fitCloudCollar;
  f.options.cloudFaceService.measureCloudSuitFace=async (...args)=>{
   cloudCalls++;
   const result=await measure(...args);
   return available ? result : {...result,provider:'unknown'};
  };
  f.options.collarFitService.fitCloudCollar=async (input,work,face,template,auth)=>{
   collarCalls++;
   assert.equal(face.chinY,55.82);
   return fit(input,work,face,template,auth);
  };
  await probePage(tool,{...f.options,exercise:async h=>{
   await dress(h);
   h.flow.update({suit:{enabled:false,templateId:'research-white'}});
   node(h,'suit-consent').props.onClick();
   assert.equal((await h.flow.applySuit()).ok,available);
   assert.equal(cloudCalls,1);
   assert.equal(collarCalls,available?1:0);
   assert.equal(f.composes,available?1:0);
  }});
 }
});
