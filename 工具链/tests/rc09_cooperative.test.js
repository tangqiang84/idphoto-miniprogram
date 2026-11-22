'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runClassicalFallback}=require('../../idphoto-miniprogram/src/core/mattingLocal');
const {runCooperative}=require('../../idphoto-miniprogram/src/core/mattingCooperative');
test('分段传统抠图逐元素与同步旧基线完全相同，包含空前景/混色/自定义背景',async()=>{for(const [w,h] of [[1,1],[31,47],[127,83]])for(const mode of [0,1,2]){const p=Uint8ClampedArray.from({length:w*h*4},(_,i)=>mode===0?0:((i*73+(i>>3)*17)%256));const opts=mode===2?{bgSamples:[[250,250,250],[240,245,250],[230,240,245]]}:{};const expected=runClassicalFallback(p,w,h,opts);assert.deepEqual(await runCooperative(p,w,h,opts),expected);}});
test('处理期间允许事件循环推进，取消后拒绝返回alpha',async()=>{let ticks=0;const t=setInterval(()=>ticks++,1);try{await runCooperative(new Uint8ClampedArray(591*827*4),591,827);assert.ok(ticks>1);}finally{clearInterval(t);}let valid=true;setTimeout(()=>{valid=false;},0);await assert.rejects(runCooperative(new Uint8ClampedArray(128*128*4),128,128,{check(){if(!valid)throw{code:'CANCELLED'};}}),{code:'CANCELLED'});});
