'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path'),ts=require('../../idphoto-miniprogram/node_modules/typescript');
test('VK完成不得在原生回调栈内重入释放，且完成前释放一次',async()=>{
 const root=process.env.RC09_VK_TEST_ROOT||path.resolve(__dirname,'../../idphoto-miniprogram');let inside=false,stop=0,destroy=0,reentered=false;
 const exports={};const source=fs.readFileSync(path.join(root,'src/services/faceService.ts'),'utf8')+'\nexports.testDetectByVisionKit=detectByVisionKit;';
 const wx={getDeviceInfo:()=>({platform:'android',version:'8.0.77'}),createVKSession:()=>({on(){},off(){},start(cb){inside=true;try{cb(1);}finally{inside=false;}},stop(){if(inside)reentered=true;stop++;},destroy(){if(inside)reentered=true;destroy++;}})};
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new vm.Script(code).runInNewContext({exports,wx,setTimeout,clearTimeout,console,require(n){if(n==='@tarojs/taro')return{__esModule:true,default:{setStorageSync(){}}};if(n.includes('/core/'))return require(path.join(root,'src/core',path.basename(n)));throw Error(n);}});
 const result=await exports.testDetectByVisionKit(new Uint8ClampedArray(64),4,4);assert.equal(result.ok,false);assert.equal(reentered,false);assert.equal(stop,1);assert.equal(destroy,1);
});
