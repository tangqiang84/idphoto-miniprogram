'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {assess}=require('../rc09_acceptance');const manifest=require('../../docs/RC-09资源验收清单.json');
test('RC-09资源门禁不将缺资源或未执行当通过，改PASS缺证据也拒绝',()=>{const r=assess(manifest);assert.equal(r.status,'BLOCKED');assert.equal(r.counts.PASS,0);assert.equal(r.counts.BLOCKED,8);assert.equal(r.counts.SKIPPED,1);const fake=JSON.parse(JSON.stringify(manifest));fake.items[0].status='PASS';assert.equal(assess(fake).status,'FAIL');fake.items.pop();assert.equal(assess(fake).status,'FAIL');});
