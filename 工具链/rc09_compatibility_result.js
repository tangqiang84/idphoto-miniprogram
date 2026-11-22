'use strict';
function compareTensor(out, spec) {
  if (!out || out.type !== 'float32' || !Array.isArray(out.shape) || out.shape.join(',') !== spec.outputShape.join(',') || !(out.data instanceof ArrayBuffer) || out.data.byteLength !== spec.expected.length * 4) return {status:'FAIL',code:'TENSOR_CONTRACT_INVALID'};
  const values=new Float32Array(out.data);
  let nonFiniteCount=0,mismatchCount=0,maxAbsError=0;
  for(let i=0;i<values.length;i++) {
    if(!Number.isFinite(values[i])) {nonFiniteCount++;continue;}
    const error=Math.abs(values[i]-spec.expected[i]);
    maxAbsError=Math.max(maxAbsError,error);
    if(error>spec.atol+spec.rtol*Math.abs(spec.expected[i]))mismatchCount++;
  }
  return {status:nonFiniteCount||mismatchCount?'FAIL':'PASS',code:nonFiniteCount?'NON_FINITE_OUTPUT':mismatchCount?'NUMERICAL_MISMATCH':'OK',nonFiniteCount,mismatchCount,maxAbsError};
}
module.exports={compareTensor};
