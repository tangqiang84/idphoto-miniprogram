'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planSuitImage,mapSuitPoints,resizeSuitMask}=require('../suitImageSpace');
test('大工作图先缩到768，576×768和小图不放大，奇数尺寸保留实际映射比例',()=>{
 assert.deepEqual(planSuitImage(1200,1600),{width:576,height:768,workWidth:1200,workHeight:1600});
 assert.equal(planSuitImage(576,768).width,576);assert.equal(planSuitImage(32,48).height,48);
 const p=planSuitImage(1001,1600);assert.equal(p.width,480);assert.equal(p.height,768);
 assert.deepEqual(mapSuitPoints([{x:240,y:384}],480,768,{width:1001,height:1600}),[{x:500.5,y:800}]);
 for(const size of [[0,10],[NaN,10],[1600,1600],[12.5,100]])assert.throws(()=>planSuitImage(...size));
});
test('掩码最近邻恢复工作尺寸，不插值制造新类别且坐标对应独立固定像素',()=>{
 const m=Uint8Array.from([1,0,0,1]);assert.deepEqual(Array.from(resizeSuitMask(m,2,2,{width:4,height:4})),[1,1,0,0,1,1,0,0,0,0,1,1,0,0,1,1]);
 assert.equal(resizeSuitMask(m,2,2,{width:2,height:2}),m);
 assert.throws(()=>resizeSuitMask(m,3,2,{width:4,height:4}));
});
