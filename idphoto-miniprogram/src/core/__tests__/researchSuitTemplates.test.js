'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getSuitTemplateStatus,getSuitTemplate}=require('../suitTemplates');
const {parsePoseResult}=require('../poseContract');
const {measuredShoulders}=require('../suitSafety');
const {SPECS}=require('../specLibrary');
test('研究素材用途明确，白色模板覆盖九规格；2500px模板不放宽2504px门槛',()=>{
 for(const s of SPECS)assert.equal(getSuitTemplateStatus('research-white',s.id).ok,true);
 for(const id of ['research-navy','research-black']){
  for(const s of SPECS)assert.equal(getSuitTemplateStatus(id,s.id).ok,s.id!=='big-two-inch');
  assert.equal(getSuitTemplateStatus(id,'big-two-inch').code,'suit:template_resolution');
  const t=getSuitTemplate(id);assert.equal(t.approval,'research');assert.equal(t.usage,'research-only');assert.equal(t.licenseEvidence,null);
 }
});
test('姿态解析不得把超过1的置信度钳为可靠分数',()=>{
 const p=parsePoseResult({keypoints:[{name:'left_shoulder',x:.2,y:.8,score:2},{name:'right_shoulder',x:.8,y:.8,score:.9}]});
 assert.equal(p.points[0].score,2);assert.equal(measuredShoulders(p.points,100,140),null);
});
test('姿态原始提供方错误不进入可读提示',()=>{
 assert.ok(!parsePoseResult({error:'PRIVATE_FIXTURE'}).message.includes('PRIVATE_FIXTURE'));
});
