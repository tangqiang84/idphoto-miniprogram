'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {suitCompose}=require('../suit');
test('透明像素隐藏RGB不能在双线性边缘形成红边或灰边',()=>{
 const rgba=new Uint8ClampedArray([0,0,0,255,0,0,0,255]);
 const tpl=new Uint8ClampedArray([255,255,255,255,255,0,0,0]);
 const out=suitCompose(rgba,new Float32Array([1,1]),1,2,tpl,2,1,{x:0,y:1,w:1,h:1},0,{protectUntilY:1});
 assert.deepEqual(Array.from(out.slice(4)),[128,128,128,255]);
 assert.deepEqual(Array.from(out.slice(0,4)),[0,0,0,255]);
});
