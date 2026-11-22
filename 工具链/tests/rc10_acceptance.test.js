'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const resource=require('../../docs/RC-10资源验收清单.json');
const {getSuitTemplateStatus}=require('../../idphoto-miniprogram/src/core/suitTemplates');
test('RC-10资源状态须有依据，研究接入不冒充真实质量验收',()=>{
 assert.equal(resource.items.length,9);assert.equal(new Set(resource.items.map(x=>x.id)).size,9);
 for(const item of resource.items){assert.ok(['PASS','FAIL','BLOCKED','SKIPPED','N/A'].includes(item.status));assert.ok(item.reason);assert.ok(item.evidence.length);}
 for(const id of ['HISTORICAL_FACE_REGRESSION','REAL_SHOULDER_ALIGNMENT'])assert.equal(resource.items.find(i=>i.id===id).status,'BLOCKED');
 // 实测失败必须保留FAIL，不能伪装为尚未执行的BLOCKED。
 assert.equal(resource.items.find(i=>i.id==='VISUAL_QUALITY').status,'FAIL');
 assert.equal(resource.items.find(i=>i.id==='NATIVE_CLOTHING_MODEL').status,'N/A');
 assert.equal(resource.items.find(i=>i.id==='CLOUD_CLOTHING_MODEL').status,'PASS');
 const deployed=require('../../docs/验证记录/RC-10-cloud-deploy-20261122-01/function-info.json').fields[0];
 assert.equal(deployed.Status,'Active');assert.equal(deployed.Runtime,'Python3.11');assert.equal(deployed.MemorySize,1536);
 assert.equal(resource.items.find(i=>i.id==='APPROVED_TEMPLATES').researchStatus,'PASS');
 assert.equal(resource.items.find(i=>i.id==='POSE_DEPLOYMENT').status,'PASS');
 for(const id of ['black','navy','gray'])assert.equal(getSuitTemplateStatus(id,'one-inch').code,'suit:template_unapproved');
});
