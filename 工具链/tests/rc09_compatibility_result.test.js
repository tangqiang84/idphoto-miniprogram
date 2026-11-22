'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {compareTensor}=require('../rc09_compatibility_result');
const spec={outputShape:[1,2],expected:[0,2],atol:1e-4,rtol:1e-4};
const tensor=values=>({shape:[1,2],type:'float32',data:new Float32Array(values).buffer});
test('数值比较区分非有限、有限错误和正确结果',()=>{
 assert.equal(compareTensor(tensor([0,2]),spec).status,'PASS');
 assert.equal(compareTensor(tensor([NaN,Infinity]),spec).nonFiniteCount,2);
 assert.equal(compareTensor(tensor([0,3]),spec).code,'NUMERICAL_MISMATCH');
 assert.equal(compareTensor(tensor([0,3]),spec).mismatchCount,1);
});
test('维度、数据类型、缓冲区不符拒绝通过',()=>{
 for(const out of [null,{...tensor([0,2]),shape:[2,1]},{...tensor([0,2]),type:'int32'}, {...tensor([0,2]),data:new Float32Array([0,2])},tensor([0])]) assert.equal(compareTensor(out,spec).code,'TENSOR_CONTRACT_INVALID');
});
