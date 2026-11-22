'use strict';
async function rebuild(base, spec, decode, check=()=>{}) {
 if(!(base instanceof Uint8Array)||!Number.isSafeInteger(spec.byteLength)||spec.byteLength<=0||spec.byteLength>64*1024*1024||!Array.isArray(spec.segments)||spec.segments.length>4096)throw {code:'DELTA_INVALID'};
 const out=new Uint8Array(spec.byteLength);let cursor=0;
 for(let i=0;i<spec.segments.length;i++) {
  check();const part=spec.segments[i];let bytes;
  if(typeof part.literal==='string')bytes=new Uint8Array(decode(part.literal));
  else {
   if(!Number.isSafeInteger(part.offset)||!Number.isSafeInteger(part.length)||part.offset<0||part.length<0||part.offset+part.length>base.length)throw {code:'DELTA_INVALID'};
   bytes=base.subarray(part.offset,part.offset+part.length);
  }
  if(cursor+bytes.length>out.length)throw {code:'DELTA_INVALID'};
  out.set(bytes,cursor);cursor+=bytes.length;
  if((i+1)%32===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
 check();if(cursor!==out.length)throw {code:'DELTA_INVALID'};
 return out;
}
function inspectBoundary(out,spec) {
 const length=spec.outputShape.reduce((a,b)=>a*b,1);
 if(!out||out.type!=='float32'||!Array.isArray(out.shape)||out.shape.join(',')!==spec.outputShape.join(',')||!(out.data instanceof ArrayBuffer)||out.data.byteLength!==length*4)return {status:'FAIL',code:'TENSOR_CONTRACT_INVALID'};
 const values=new Float32Array(out.data);let nanCount=0,infCount=0,min=Infinity,max=-Infinity,sum=0;
 for(const v of values) {if(Number.isNaN(v))nanCount++;else if(!Number.isFinite(v))infCount++;else {min=Math.min(min,v);max=Math.max(max,v);sum+=v;}}
 let mismatchCount=0,maxSampleError=0,finiteSampleCount=0;
 for(let i=0;i<spec.sampleIndices.length;i++) {
  const actual=values[spec.sampleIndices[i]],expected=spec.samples[i],error=Math.abs(actual-expected);
  if(!Number.isFinite(actual)||error>spec.atol+spec.rtol*Math.abs(expected))mismatchCount++;
  if(Number.isFinite(error)){maxSampleError=Math.max(maxSampleError,error);finiteSampleCount++;}
 }
 const nonFiniteCount=nanCount+infCount;
 return {status:nonFiniteCount||mismatchCount?'FAIL':'PASS',code:nonFiniteCount?'NON_FINITE_OUTPUT':mismatchCount?'SAMPLED_MISMATCH':'FINITE_SAMPLES_OK',coverage:'all-finite+sampled-numeric',nanCount,infCount,nonFiniteCount,mismatchCount,finiteSampleCount,maxSampleError:finiteSampleCount?maxSampleError:null,min:Number.isFinite(min)?min:null,max:Number.isFinite(max)?max:null,mean:nonFiniteCount?null:sum/length};
}
function inspectNormalization(input,output,spec) {
 const shape=spec.shape,[batch,channels,height,width]=shape,area=height*width;
 if(batch!==1||!input||!output||input.type!=='float32'||output.type!=='float32'||!(input.data instanceof ArrayBuffer)||!(output.data instanceof ArrayBuffer)||input.shape?.join(',')!==shape.join(',')||output.shape?.join(',')!==shape.join(',')||input.data.byteLength!==channels*area*4||output.data.byteLength!==channels*area*4)return {nodeIndex:spec.nodeIndex,status:'FAIL',code:'NORMALIZATION_CONTRACT_INVALID'};
 const x=new Float32Array(input.data),y=new Float32Array(output.data),means=[],variances=[];
 let inputNonFiniteCount=0;for(const value of x)if(!Number.isFinite(value))inputNonFiniteCount++;
 if(inputNonFiniteCount)return {nodeIndex:spec.nodeIndex,status:'FAIL',code:'NORMALIZATION_INPUT_NON_FINITE',inputNonFiniteCount};
 let outputNonFiniteCount=0,mismatchCount=0,maxError=0,finiteComparisons=0;
 for(let channel=0;channel<channels;channel++) {
  const start=channel*area;let sum=0;for(let i=0;i<area;i++)sum+=x[start+i];const mean=sum/area;
  let squares=0;for(let i=0;i<area;i++){const delta=x[start+i]-mean;squares+=delta*delta;}const variance=squares/area;
  means.push(mean);variances.push(variance);const divisor=Math.sqrt(variance+spec.epsilon);
  for(let i=0;i<area;i++) {
   const expected=(x[start+i]-mean)/divisor*spec.scale[channel]+spec.bias[channel],actual=y[start+i];
   if(!Number.isFinite(actual)){outputNonFiniteCount++;continue;}
   const error=Math.abs(actual-expected);finiteComparisons++;maxError=Math.max(maxError,error);
   if(error>spec.atol+spec.rtol*Math.abs(expected))mismatchCount++;
  }
 }
 return {nodeIndex:spec.nodeIndex,status:outputNonFiniteCount||mismatchCount?'FAIL':'PASS',code:outputNonFiniteCount?'NORMALIZATION_OUTPUT_NON_FINITE':mismatchCount?'NORMALIZATION_MISMATCH':'NORMALIZATION_MATH_OK',basis:'actual-native-input+two-pass-float64-math',inputNonFiniteCount,outputNonFiniteCount,mismatchCount,finiteComparisons,maxError:finiteComparisons?maxError:null,minChannelVariance:Math.min(...variances),maxChannelVariance:Math.max(...variances),channelMeans:means,channelVariances:variances,epsilon:spec.epsilon};
}
module.exports={rebuild,inspectBoundary,inspectNormalization};
