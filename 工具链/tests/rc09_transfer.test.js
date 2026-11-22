'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {transferOffset}=require('../rc09_native_device');
test('RC-09残缺设备缓存必须验证前缀再续传，存在不等于完整',()=>{
 const b=Buffer.from('abc');
 assert.equal(transferOffset({exists:false},b,false),0);
 assert.equal(transferOffset({exists:true,size:2,digest:'187ef4436122d1cc2f40dc2b92f0eba0'},b,true),2);
 assert.equal(transferOffset({exists:true,size:3,digest:'900150983cd24fb0d6963f7d28e17f72'},b,true),3);
});
test('RC-09设备缓存损坏/过长及非复用目标拒绝，不覆盖旧文件',()=>{
 const b=Buffer.from('abc');
 assert.throws(()=>transferOffset({exists:true,size:2,digest:'invalid'},b,true),/PREFIX_MISMATCH/);
 assert.throws(()=>transferOffset({exists:true,size:4},b,true),/SIZE_INVALID/);
 assert.throws(()=>transferOffset({exists:true,size:2},b,false),/OUTPUT_EXISTS/);
});
