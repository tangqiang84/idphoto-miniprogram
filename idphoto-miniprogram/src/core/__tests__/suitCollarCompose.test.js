'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {composeCollarSuit}=require('../suitCollarCompose');
function fixture(){return {width:8,height:10,rgba:new Uint8ClampedArray(320).fill(200),alpha:new Float32Array(80).fill(1),clothing:new Uint8Array(80).fill(1),background:new Uint8Array(80),faceRect:{x:2,y:1,w:4,h:4},tpl:new Uint8ClampedArray(8*8*4),tplW:8,tplH:8,geometry:{left:0,top:0,scale:1,protectY:4,templateWidth:8,templateHeight:8}};}
test('领口衣料可经过下巴外侧，保护区每个RGBA和alpha严格保持；旧衣清除不染入新衣',()=>{const p=fixture();for(let i=0;i<64;i++)p.tpl.set([10,20,30,255],i*4);const r=composeCollarSuit(p);for(let i=0;i<80;i++)if(r.protectedMask[i]){assert.equal(r.alpha[i],1);assert.deepEqual(r.rgba.slice(i*4,i*4+4),p.rgba.slice(i*4,i*4+4));}assert.deepEqual(Array.from(r.rgba.slice(0,3)),[10,20,30]);assert.equal(r.alpha[0],1);assert.equal(r.alpha[7],0);});
test('透明领口不填入旧衣，衣身延展仍覆盖画布底部',()=>{const p=fixture();for(let y=4;y<8;y++)for(let x=0;x<8;x++)p.tpl.set([100,50,25,255],(y*8+x)*4);const r=composeCollarSuit(p);assert.equal(r.alpha[0],0);assert.equal(r.alpha[9*8+3],1);});
test('非法几何拒绝出图，源数据不被修改',()=>{for(const scale of [0,-1,NaN,Infinity]){const p=fixture();p.geometry.scale=scale;const before=p.rgba.slice();assert.throws(()=>composeCollarSuit(p),e=>e.code==='SUIT_FIT_INVALID');assert.deepEqual(p.rgba,before);}});
