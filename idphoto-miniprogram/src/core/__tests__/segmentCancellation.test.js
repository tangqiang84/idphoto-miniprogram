const test=require('node:test');
const assert=require('node:assert/strict');
const {segment}=require('../matting');
const {toBase64}=require('../mattingCloud');
function input(extra={}) {return {rgba:new Uint8ClampedArray(16*16*4),width:16,height:16,forceCloud:true,consents:['faceCloudEnhance'],...extra};}
test('已过期会话不得启动处理或上传',async()=>{
 let calls=0;
 await assert.rejects(segment(input({check(){throw {code:'SESSION_STALE'};},cloud:{adapter:{endpoint:'cloud://CN',async call(){calls++;}}}})),{code:'SESSION_STALE'});
 assert.equal(calls,0);
});
for(const rejects of [false,true]) test(`云在途取消后不得返回成功或降级 ${rejects}`,async()=>{
 let stale=false,calls=0;
 await assert.rejects(segment(input({check(){if(stale)throw {code:'SESSION_STALE'};},cloud:{adapter:{endpoint:'cloud://CN',async call(req){calls++;stale=true;if(rejects)throw Error('network');return {provider:'baidu',alphaB64:toBase64(new Uint8Array(req.width*req.height).fill(128))};}}}})),{code:'SESSION_STALE'});
 assert.equal(calls,1);
});
test('授权撤回错误不得包装为网络降级',async()=>{
 await assert.rejects(segment(input({cloud:{adapter:{endpoint:'cloud://CN',async call(){throw {code:'CONSENT_REVOKED'};}}}})),{code:'CONSENT_REVOKED'});
});
