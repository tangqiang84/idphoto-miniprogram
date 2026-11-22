'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {decodePNG,encodePNG}=require('../idphoto-miniprogram/cloudfunctions/matting/png');
const templates=require('../idphoto-miniprogram/src/core/researchSuitTemplates.json');
const {SPECS,getPixelSize}=require('../idphoto-miniprogram/src/core/specLibrary');
const {getSuitTemplateStatus}=require('../idphoto-miniprogram/src/core/suitTemplates');
const {fitSuitV2}=require('../idphoto-miniprogram/src/core/suitFitV2');
const {suitCompose}=require('../idphoto-miniprogram/src/core/suit');
const output=process.argv[2];
assert.ok(output);fs.mkdirSync(output,{recursive:false});
const cases=[];
for(const t of templates){const png=decodePNG(fs.readFileSync(path.join(__dirname,'../idphoto-miniprogram/cloudfunctions/matting/suit-assets',t.asset)));
 for(const spec of SPECS)for(const dpi of [300,600]){
  const allowed=getSuitTemplateStatus(t.id,spec.id);if(!allowed.ok){cases.push({template:t.id,spec:spec.id,dpi,status:'PASS',assertion:'resolution-rejected',code:allowed.code});continue;}
  const {width:w,height:h}=getPixelSize(spec,dpi),headH=h*(spec.headHeightRatioMin+spec.headHeightRatioMax)/2,crownY=h*.03,chinY=crownY+headH;
  const face={source:'landmarks',quality:'good',faceCount:1,crownY,chinY,headH,faceCenterX:w/2,rect:{x:w*.33,y:crownY,w:w*.34,h:headH}};
  const pose={personCount:1,points:[{name:'left_shoulder',x:w*.12,y:h*.9,score:.9},{name:'right_shoulder',x:w*.88,y:h*.9,score:.9}]};
  const fit=fitSuitV2({spec,canvasW:w,canvasH:h,face,pose,template:t.geometry});assert.equal(fit.ok,true,`${t.id}/${spec.id}/${dpi}: ${fit.reason}`);
  const before=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)before.set([180,205,225,255],i*4);
  const out=suitCompose(before,new Float32Array(w*h).fill(1),w,h,png.data,png.width,png.height,fit.place,fit.rotateDeg,{protectUntilY:fit.protectUntilY});
  assert.deepEqual(out.subarray(0,fit.protectUntilY*w*4),before.subarray(0,fit.protectUntilY*w*4));
  let changed=0;for(let i=fit.protectUntilY*w*4;i<out.length;i+=4)if(out[i]!==before[i]||out[i+1]!==before[i+1]||out[i+2]!==before[i+2])changed++;
  assert.ok(changed>0);
  const file=`${t.id}-${spec.id}-${dpi}.png`;fs.writeFileSync(path.join(output,file),encodePNG(out,w,h),{flag:'wx'});
  cases.push({template:t.id,spec:spec.id,dpi,status:'PASS',assertion:'synthetic-anchor-and-face-protection',protectedChanges:0,changed,file,fit});
 }
}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({time:new Date().toISOString(),signalSource:'synthetic-fixture',realQualityPassed:false,cases},null,2),{flag:'wx'});
console.log(JSON.stringify({cases:cases.length,success:cases.filter(x=>x.file).length,rejected:cases.filter(x=>!x.file).length}));
