'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {assessPixels,validateArtifact}=require('../outputEvidence');
const {getPixelSize}=require('../specLibrary');
const expected={ 'one-inch':[[295,413],[591,827]],'small-one-inch':[[260,378],[520,756]],'driver-license':[[260,378],[520,756]],'two-inch':[[413,579],[827,1157]],'small-two-inch':[[413,531],[827,1063]],'big-one-inch':[[390,567],[780,1134]],'big-two-inch':[[413,626],[827,1252]],'passport-cn':[[390,567],[780,1134]],'visa-us':[[600,600],[1200,1200]]};
test('RC-08九规格双档固定期望来自已确认规格参考表',()=>{for(const [id,rows] of Object.entries(expected))rows.forEach(([width,height],i)=>assert.deepEqual(getPixelSize(id,i?600:300),{width,height,dpi:i?600:300}));});
test('RC-08大原图小裁剪与已放大工作图不能自证细节充足',()=>{
 const r=assessPixels({width:300,height:420},{width:591,height:827},{width:1600,height:2240});assert.equal(r.sourceEnough,false);assert.equal(r.processingEnough,true);
 assert.equal(assessPixels(null,{width:591,height:827},{width:1600,height:2240}).sourceEnough,null);
 assert.equal(assessPixels({width:1200,height:1600},{width:591,height:827},{width:300,height:420}).processingEnough,false);
});
test('RC-08实际落盘格式尺寸与原始字节必须一致，扩展名不能替代格式',()=>{
 const target={width:295,height:413};const f={width:295,height:413,type:'jpeg',bytes:204801};
 assert.equal(validateArtifact(f,target,'jpg').ok,true);assert.equal(validateArtifact({...f,type:'png'},target,'jpg').code,'EXPORT_FORMAT');
 assert.equal(validateArtifact({...f,width:296},target,'jpg').code,'EXPORT_DIMENSION');
 assert.equal(validateArtifact({...f,type:undefined},target,'jpg').ok,false);
 assert.equal(validateArtifact({...f,bytes:NaN},target,'jpg').ok,false);
});
