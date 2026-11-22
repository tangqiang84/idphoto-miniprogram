'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fitSuitV2}=require('../suitFitV2');
const {getSpec}=require('../specLibrary');
function input(angle=0){const rad=angle*Math.PI/180;return {spec:getSpec('one-inch'),canvasW:400,canvasH:600,
 face:{source:'landmarks',quality:'good',faceCount:1,crownY:48,chinY:438,headH:390,faceCenterX:200,rect:{x:130,y:120,w:140,h:318}},
 pose:{personCount:1,points:[{name:'left_shoulder',x:200-150*Math.cos(rad),y:520-150*Math.sin(rad),score:.9},{name:'right_shoulder',x:200+150*Math.cos(rad),y:520+150*Math.sin(rad),score:.9}]},
 template:{width:400,height:400,shoulderWidthPx:200,shoulderY:200,collarTopY:165,collarVy:230,shoulderAnchors:[{x:100,y:200},{x:300,y:200}]}};}
function project(p,fit,tpl){const rad=fit.rotateDeg*Math.PI/180,dx=(p.x-tpl.width/2)*fit.scale,dy=(p.y-tpl.height/2)*fit.scale;return {x:fit.place.x+fit.place.w/2+dx*Math.cos(rad)-dy*Math.sin(rad),y:fit.place.y+fit.place.h/2+dx*Math.sin(rad)+dy*Math.cos(rad)};}
test('RC-10显式模板肩峰经合成中心旋转后逐点落在实测双肩，不能限宽缩小',()=>{for(const angle of [-8,0,8]){const p=input(angle),r=fitSuitV2(p);assert.equal(r.ok,true);for(let i=0;i<2;i++){const q=project(p.template.shoulderAnchors[i],r,p.template),s=p.pose.points[i];assert.ok(Math.hypot(q.x-s.x,q.y-s.y)<1e-8,JSON.stringify({q,s}));}assert.ok(Math.abs(r.place.w-600)<1e-8);assert.ok(r.place.x<0);}});
test('RC-10模板肩峰整体平移不改变合成，透明留白不是人体位置',()=>{const p=input(8),a=fitSuitV2(p);p.template={...p.template,width:500,height:500,collarTopY:215,collarVy:280,shoulderY:250,shoulderAnchors:p.template.shoulderAnchors.map(q=>({x:q.x+50,y:q.y+50}))};const b=fitSuitV2(p);assert.equal(b.ok,true);for(let i=0;i<2;i++){const q=project(p.template.shoulderAnchors[i],b,p.template);assert.ok(Math.hypot(q.x-p.pose.points[i].x,q.y-p.pose.points[i].y)<1e-8);}assert.equal(a.scale,b.scale);});
test('RC-10错误或退化肩峰元数据不得静默走旧猜测分支',()=>{for(const anchors of [[],[{x:100,y:200}],[{x:100,y:200},{x:100,y:200}],[{x:-1,y:200},{x:300,y:200}],[{x:100,y:NaN},{x:300,y:200}]]){const p=input();p.template.shoulderAnchors=anchors;const r=fitSuitV2(p);assert.equal(r.ok,false);assert.equal(r.reason,'suit:template_metadata');}});
test('RC-10实测肩峰与模板领口安全冲突时拒绝，禁止移走肩点伪装对齐',()=>{const p=input();p.template.collarTopY=100;const r=fitSuitV2(p);assert.equal(r.ok,false);assert.equal(r.reason,'suit:unsupported_composition');});
