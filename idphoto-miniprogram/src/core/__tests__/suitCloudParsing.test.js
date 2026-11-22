'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {decodeSuitClasses} = require('../suitCloudParsing');
test('ATR服装类别映射与皮肤/脸/头发独立，非法类别和尺寸拒绝', () => {
 const labels=Uint8Array.from({length:18},(_,i)=>i),r=decodeSuitClasses(labels,18,1);
 assert.deepEqual(Array.from(r.clothing),[0,0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,1]);
 for(const [data,w,h] of [[new Uint8Array([18]),1,1],[new Uint8Array(1),2,1],[new Uint8Array(1),true,1],[new Uint8Array(1),2049,1]])assert.throws(()=>decodeSuitClasses(data,w,h));
});
test('头发邻域保护与独立朴素邻域算法一致，不把皮肤当衣服',()=>{
 const w=31,h=19,radius=2,labels=new Uint8Array(w*h);labels[5*w+6]=2;labels[17*w+30]=2;labels[10*w+15]=11;
 const out=decodeSuitClasses(labels,w,h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let hair=false;for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius);yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)if(labels[yy*w+xx]===2)hair=true;assert.equal(out.background[y*w+x],labels[y*w+x]===0&&!hair?1:0);}
 assert.equal(out.clothing[10*w+15],0);
});
