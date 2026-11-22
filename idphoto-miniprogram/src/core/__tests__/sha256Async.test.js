'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
const {sha256,sha256Async}=require('../sha256');
test('异步SHA256保持独立原生摘要，分块校验期间事件循环可运行',async()=>{
 const b=new Uint8Array(200000).fill(37),expected=crypto.createHash('sha256').update(b).digest('hex');let tick=false;setTimeout(()=>{tick=true;},0);
 assert.equal(await sha256Async(b),expected);assert.equal(tick,true);assert.equal(sha256(b),expected);
});
test('异步SHA256授权撤回/取消在后续块停止，不返回摘要',async()=>{
 let allowed=true;setTimeout(()=>{allowed=false;},0);
 await assert.rejects(sha256Async(new Uint8Array(200000),{check(){if(!allowed)throw {code:'CANCELLED'};}}),{code:'CANCELLED'});
});
