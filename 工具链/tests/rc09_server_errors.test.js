const test=require('node:test'),assert=require('node:assert/strict');
const {handleMatting}=require('../../idphoto-miniprogram/cloudfunctions/matting');
test('云端百度异常不得泄露原异常且带TraceID',async()=>{
 const logs=[],old=console.warn;console.warn=(...a)=>logs.push(a);
 try{const r=await handleMatting({consent:'faceCloudEnhance',region:'CN',width:16,height:16,image:Buffer.alloc(1024).toString('base64')},{env:{BAIDU_API_KEY:'fixture',BAIDU_SECRET_KEY:'fixture'},clientFactory(){throw Object.assign(Error('PRIVATE_FIXTURE'),{code:17});}});
 assert.equal(r.provider,'shadow');assert.equal(r.providerMeta.code,17);
 assert.ok(r.traceId);assert.equal(JSON.stringify([r,logs]).includes('PRIVATE_FIXTURE'),false);
 }finally{console.warn=old;}
});
