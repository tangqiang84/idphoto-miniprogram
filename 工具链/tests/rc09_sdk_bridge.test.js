const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),ts=require('../../idphoto-miniprogram/node_modules/typescript');
const utils=require('../../idphoto-miniprogram/src/core/asyncUtils');
function load(call){const exports={};new vm.Script(ts.transpileModule(fs.readFileSync('idphoto-miniprogram/src/services/cloudFnAdapter.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText).runInNewContext({exports,Date,Promise,console:{warn(){}},require(n){return n==='@tarojs/taro'?{__esModule:true,default:{cloud:{callFunction:call}}}:utils;}});return exports.makeCloudFnAdapter({authorization:{check(){}}});}
test('回调式SDK不返回Promise也必须取得云结果',async()=>{
 let calls=0;const a=load(o=>{calls++;queueMicrotask(()=>o.success({result:{alphaB64:'fixture',provider:'baidu'}}));});
 assert.equal((await a.call({})).provider,'baidu');assert.equal(calls,1);
});
test('回调式失败保留安全SDK码，不泄露原错误',async()=>{
 const a=load(o=>{queueMicrotask(()=>o.fail({errCode:-501000,errMsg:'PRIVATE_FIXTURE'}));});
 await assert.rejects(a.call({}),e=>e.code===-501000&&!JSON.stringify(e).includes('PRIVATE_FIXTURE'));
});
test('SDK同时回调和返回Promise只采用首次结算且不重试',async()=>{
 let calls=0;const a=load(o=>{calls++;o.success({result:{provider:'baidu'}});return Promise.reject({errCode:-1});});
 assert.equal((await a.call({})).provider,'baidu');assert.equal(calls,1);
});
