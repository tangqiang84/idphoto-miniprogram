'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../../idphoto-miniprogram/node_modules/typescript');
const {handleSuitAsset}=require('../../idphoto-miniprogram/cloudfunctions/matting/suitAssets');
const {getSuitTemplate}=require('../../idphoto-miniprogram/src/core/suitTemplates');
function load(file,taro){const cache={};function module(name){const full=path.resolve('idphoto-miniprogram/src/services',name+'.ts');if(cache[full])return cache[full];const exports={};cache[full]=exports;
 const code=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new vm.Script(code).runInNewContext({exports,Uint8Array,ArrayBuffer,Map,Promise,Date,Math,setTimeout,clearTimeout,console:{warn(){}},require(n){if(n==='@tarojs/taro')return {__esModule:true,default:taro};if(n.endsWith('.png'))return n;if(n==='./wechatInference')return require('../../idphoto-miniprogram/src/services/wechatInference');if(n.startsWith('../core/'))return require('../../idphoto-miniprogram/src/core/'+n.slice(8));return module(n.replace('./',''));}});return exports;}return module(file);}
test('客户端逐片读取原图并核验摘要，缓存后不再请求；撤销后不能复用缓存',async()=>{
 let calls=0,writes=0,revoked=false;const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'}}};
 const api={env:{USER_DATA_PATH:'fixture://'},base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,getFileSystemManager:()=>({writeFileSync(){writes++;}}),cloud:{callFunction(o){calls++;queueMicrotask(()=>o.success({result:handleSuitAsset(o.data)}));}}};
 const service=load('suitAssets',api),template=getSuitTemplate('research-navy');const file=await service.loadResearchTemplate(template,auth);
 assert.ok(file.includes(template.sha256));assert.ok(calls>1);assert.equal(writes,1);const before=calls;assert.equal(await service.loadResearchTemplate(template,auth),file);assert.equal(calls,before);
 revoked=true;await assert.rejects(service.loadResearchTemplate(template,auth));assert.equal(calls,before);
});
test('模板分片损坏或在途授权撤回均不落盘',async()=>{
 for(const mode of ['corrupt','revoke']){let writes=0,revoked=false;const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'}}};
 const api={env:{USER_DATA_PATH:'fixture://'},base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,getFileSystemManager:()=>({writeFileSync(){writes++;}}),cloud:{async callFunction(o){const result=handleSuitAsset(o.data);if(mode==='revoke')revoked=true;else result.dataB64=Buffer.alloc(Buffer.from(result.dataB64,'base64').length).toString('base64');return {result};}}};
 await assert.rejects(load('suitAssets',api).loadResearchTemplate(getSuitTemplate('research-navy'),auth));assert.equal(writes,0);
 }
});
test('姿态客户端兼容回调SDK，双授权契约及映射完整，不保留过期结果',async()=>{
 let revoked=false,calls=0;const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'}}};
 const api={cloud:{callFunction(o){calls++;assert.equal(o.name,'matting');assert.equal(o.data.action,'pose');assert.equal(o.data.suitConsent,'suitSwap');queueMicrotask(()=>o.success({result:{keypoints:[{name:'left_shoulder',x:.2,y:.8,score:.9},{name:'right_shoulder',x:.8,y:.8,score:.9}],personCount:1,model:'baidu-body-analysis'}}));}}};
 const fn=load('poseService',api).requestPoseKeypoints,req={imageB64:'AAAA',width:100,height:140,region:{x:0,y:0,w:100,h:140},canvasW:100,canvasH:140};
 const r=await fn(req,auth);assert.equal(r.ok,true);assert.equal(r.pose.personCount,1);assert.equal(r.pose.points[0].x,20);
 revoked=true;assert.equal((await fn(req,auth)).ok,false);assert.equal(calls,1);
});

test('衣物解析本地模型路径：下载只含模型请求；撤回时释放会话且丢弃结果',async()=>{
 for(const revoke of [false,true]){let calls=0,destroyed=0,revoked=false;const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'}}};
 const api={env:{USER_DATA_PATH:'fixture://'},base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,getFileSystemManager:()=>({writeFileSync(){}}),cloud:{async callFunction(o){calls++;assert.equal(o.data.action,'suit-parsing-model');assert.equal('image' in o.data,false);return {result:handleSuitAsset(o.data)};}},getInferenceEnvInfo(o){o.success({ver:"fixture-engine"})},createInferenceSession(){return {onLoad(fn){queueMicrotask(fn)},onError(){},offLoad(){},offError(){},destroy(){destroyed++},async run(){if(revoke)revoked=true;const data=new Float32Array(256*256*6);for(let i=0;i<256*256;i++)data[i*6+4]=5;return {Identity:{type:'float32',shape:[1,256,256,6],data:data.buffer}}}}}};
 const fn=load('clothingService',api).parseSuitClothing,p=fn(new Uint8ClampedArray(16).fill(100),2,2,auth);
 if(revoke)await assert.rejects(p);else {const r=await p;assert.ok(r.clothing.every(v=>v===1));assert.equal(r.evidence.provider,'wechat-native-selfie-multiclass');}
 assert.equal(calls,32);assert.equal(destroyed,1);
 }
});

test('缺原生推理能力时衣物解析拒绝且不下载、不写文件',async()=>{
 let calls=0;const api={cloud:{callFunction(){calls++;throw new Error('UNEXPECTED_DOWNLOAD')}},getFileSystemManager(){calls++;throw new Error('UNEXPECTED_WRITE')}};
 await assert.rejects(load('clothingService',api).parseSuitClothing(new Uint8ClampedArray(16),2,2,{check(){}}),e=>e.code==='SUIT_CLOTHING_RUNTIME_UNAVAILABLE'&&!!e.traceId);assert.equal(calls,0);
});

test('摘要命名持久缓存跨服务重启复用，损坏缓存保留并写新路径',async()=>{
 const store=new Map();let calls=0,writes=0;const api={env:{USER_DATA_PATH:'fixture://'},base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,getFileSystemManager:()=>({accessSync(p){if(!store.has(p))throw new Error('MISSING')},readFileSync:p=>store.get(p),writeFileSync(p,b){assert.equal(store.has(p),false);store.set(p,b);writes++;}}),cloud:{async callFunction(o){calls++;return {result:handleSuitAsset(o.data)}}}};
 const t=getSuitTemplate('research-navy'),auth={check(){}};const file=await load('suitAssets',api).loadResearchTemplate(t,auth),before=calls;
 assert.equal(await load('suitAssets',api).loadResearchTemplate(t,auth),file);assert.equal(calls,before);assert.equal(writes,1);
 store.set(file,new ArrayBuffer(1));const replacement=await load('suitAssets',api).loadResearchTemplate(t,auth);assert.notEqual(replacement,file);assert.equal(store.get(file).byteLength,1);assert.equal(writes,2);
});

test('推理引擎查询失败或无版本时拒绝，零资产请求及会话创建',async()=>{for(const mode of ['fail','empty','throw']){let calls=0;const api={createInferenceSession(){calls++},getInferenceEnvInfo(o){if(mode==='throw')throw Error('PRIVATE');if(mode==='fail')o.fail({errMsg:'PRIVATE'});else o.success({ver:''})},cloud:{callFunction(){calls++}}};await assert.rejects(load('clothingService',api).parseSuitClothing(new Uint8ClampedArray(16),2,2,{check(){}}),e=>e.code==='SUIT_CLOTHING_RUNTIME_UNAVAILABLE'&&!JSON.stringify(e).includes('PRIVATE'));assert.equal(calls,0);}});

test('云衣物解析验证固定来源及撤回授权；无授权零请求',async()=>{
 const {MODEL_SHA,PROVIDER}=require('../../idphoto-miniprogram/src/core/suitCloudParsing');
 for(const mode of ['ok','before','after','sha','label','size','remote-error']){
  let calls=0,revoked=mode==='before';const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'};}};
  const api={base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,cloud:{async callFunction(o){calls++;assert.equal(o.name,'suitparse');assert.equal(o.data.consent,'faceCloudEnhance');assert.equal(o.data.suitConsent,'suitSwap');if(mode==='after')revoked=true;return {result:{ok:mode!=='remote-error',message:'PRIVATE_ERROR',width:mode==='size'?3:2,height:2,provider:PROVIDER,modelSha256:mode==='sha'?'wrong':MODEL_SHA,classesB64:Buffer.from([mode==='label'?18:4,2,0,11]).toString('base64')}};}}};
  const call=load('cloudClothingService',api).parseCloudSuitClothing('AAAA',2,2,auth);
  if(mode==='ok'){const r=await call;assert.equal(r.clothing[0],1);assert.equal(r.evidence.provider,PROVIDER);assert.equal(r.backgroundMode,'face-exterior');}
  else await assert.rejects(call,e=>!!e.code&&!JSON.stringify(e).includes('PRIVATE_ERROR'));
  assert.equal(calls,mode==='before'?0:1);
 }
});

test('换装云人脸校验来源、478点、单人及撤回授权，不向页面传播远端异常',async()=>{
 const sha='64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
 for(const mode of ['ok','before','after','multiple','sha','nan','count','size','remote']){
  let calls=0,revoked=mode==='before';const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'};}};
  const points=Array.from({length:478},(_,i)=>({x:50+20*Math.cos(i*2*Math.PI/478),y:60+35*Math.sin(i*2*Math.PI/478)}));
  if(mode==='nan')points[0].x=NaN;if(mode==='count')points.pop();
  const api={cloud:{async callFunction(o){calls++;assert.equal(o.name,'facepoints');assert.equal(o.data.suitConsent,'suitSwap');assert.equal(o.data.purpose,'suit_face_landmarks');if(mode==='after')revoked=true;return {result:{ok:mode!=='remote',message:'PRIVATE_REMOTE',faceCount:mode==='multiple'?2:1,width:mode==='size'?101:100,height:140,provider:'mediapipe-face-landmarker-cpu',modelSha256:mode==='sha'?'wrong':sha,points}};}}};
  const promise=load('cloudFaceService',api).measureCloudSuitFace('AAAA',100,140,auth);
  if(mode==='ok'){const r=await promise;assert.equal(r.faceCount,1);assert.equal(r.facePoints.length,478);assert.equal(r.source,'landmarks');assert.equal(r.rectSource,'landmark-envelope');assert.equal(r.metrics.confidence,null);}
  else await assert.rejects(promise,e=>!!e.code&&!JSON.stringify(e).includes('PRIVATE_REMOTE'));
  assert.equal(calls,mode==='before'?0:1);
 }
});

test('换装缩图编码使用实际768尺寸，保留工作画布不重裁剪',()=>{
 let args,draw;const original={toDataURL(){throw Error('LARGE_IMAGE_ENCODED')}};
 const api={createOffscreenCanvas(o){args=o;return {getContext:()=>({drawImage(...a){draw=a}}),toDataURL:()=> 'data:image/jpeg;base64,SMALL'};}};
 const r=load('poseService',api).prepareSuitImage(original,1200,1600);
 assert.equal(r.width,576);assert.equal(r.height,768);assert.equal(r.imageB64,'SMALL');assert.equal(args.width,576);assert.equal(args.height,768);assert.deepEqual(Array.from(draw),[original,0,0,1200,1600,0,0,576,768]);
});
test('云衣物掩码恢复大工作画布，上传尺寸保持小图且离散边界不混色',async()=>{
 const {MODEL_SHA,PROVIDER}=require('../../idphoto-miniprogram/src/core/suitCloudParsing');
 const api={base64ToArrayBuffer:s=>Uint8Array.from(Buffer.from(s,'base64')).buffer,cloud:{async callFunction(o){assert.equal(o.data.width,2);assert.equal(o.data.height,2);return {result:{ok:true,width:2,height:2,provider:PROVIDER,modelSha256:MODEL_SHA,classesB64:Buffer.from([4,0,0,4]).toString('base64')}};}}};
 const r=await load('cloudClothingService',api).parseCloudSuitClothing('AAAA',2,2,{check(){}},{width:1200,height:1600});
 assert.equal(r.clothing.length,1920000);assert.equal(r.clothing[599],1);assert.equal(r.clothing[600],0);assert.equal(r.clothing[800*1200],0);assert.equal(r.clothing[800*1200+600],1);
});
test('缩图云人脸先映射点再度量，五官及保护框返回工作图坐标',async()=>{
 const points=Array.from({length:478},(_,i)=>({x:50+20*Math.cos(i*2*Math.PI/478),y:60+35*Math.sin(i*2*Math.PI/478)}));
 const api={cloud:{async callFunction(){return {result:{ok:true,faceCount:1,width:100,height:140,points,provider:'mediapipe-face-landmarker-cpu',modelSha256:'64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'}};}}};
 const fn=load('cloudFaceService',api).measureCloudSuitFace,a=await fn('AAAA',100,140,{check(){}}),b=await fn('AAAA',100,140,{check(){}},{width:1000,height:1400});
 assert.equal(b.facePoints[0].x,700);assert.equal(b.facePoints[0].y,600);assert.ok(Math.abs(b.headLengthPx-a.headLengthPx*10)<1e-8);assert.ok(Math.abs(b.faceRect.w-a.faceRect.w*10)<1e-8);assert.equal(b.faceCount,1);
});
test('领口服务验证双授权、模板摘要、几何和撤回；只返回映射几何而非低清成品',async()=>{
 const sha='35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0';
 for(const mode of ['ok','before','after','sha','geometry','template','reject']){let revoked=mode==='before',calls=0;const auth={check(){if(revoked)throw {code:'CONSENT_REQUIRED'}}};
 const api={arrayBufferToBase64:b=>Buffer.from(b).toString('base64'),cloud:{async callFunction(o){calls++;assert.equal(o.name,'suitfit');assert.equal(o.data.purpose,'suit_collar_fit');assert.equal(o.data.suitConsent,'suitSwap');assert.equal(Buffer.from(o.data.alphaB64,'base64').length,4);if(mode==='after')revoked=true;return {result:{ok:mode!=='reject',code:'SUIT_COLLAR_UNSUPPORTED',width:2,height:2,provider:'visible-neck-collar-cpu-v1',modelSha256:mode==='sha'?'bad':sha,templateId:'fixture',templateSha256:mode==='template'?'bad':'assetsha',geometry:{left:1,top:1,scale:mode==='geometry'?NaN:.5,protectY:600,templateWidth:768,templateHeight:768}}};}}};
 const promise=load('collarFitService',api).fitCloudCollar({imageB64:'AAAA',width:2,height:2},{width:4,height:4,alpha:new Float32Array(16).fill(1)},{rect:{x:1,y:1,w:2,h:2},chinY:3},{id:'fixture',sha256:'assetsha'},auth);
 if(mode==='ok'){const r=await promise;assert.equal(r.geometry.left,2);assert.equal(r.geometry.top,2);assert.equal(r.geometry.scale,1);}else await assert.rejects(promise,e=>!!e.code);
 assert.equal(calls,mode==='before'?0:1);
 }
});
