'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {failureCode}=require('../../idphoto-miniprogram/src/core/mattingEvidence');
test('百度每日额度17必须映射为额度不足且不依赖原始服务描述',()=>{assert.equal(failureCode({code:17}),'CLOUD_QUOTA');assert.equal(failureCode({code:'17',message:'private_fixture'}),'CLOUD_QUOTA');});
