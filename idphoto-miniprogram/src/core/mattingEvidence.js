'use strict';
const safeId=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(v)?v:null;
function failureCode(error){
 const code=String(error?.code??error?.errCode??error?.statusCode??'');
 const message=String(error?.message||error?.errMsg||'');
 if(['17','18','19','429','QUOTA_EXCEEDED'].includes(code)||/quota|额度|限额/i.test(message))return 'CLOUD_QUOTA';
 if(['401','403','AUTH_FAILED'].includes(code))return 'CLOUD_AUTH';
 if(/timeout|超时/i.test(code+' '+message))return 'CLOUD_TIMEOUT';
 return 'CLOUD_UNAVAILABLE';
}
function mattingEvidence({backend,provider,modelId,modelRevision,artifactSha256,reasonCodes=[],latencyMs=0,cloudAttempted=false,adapterKind,inputSize,cloudLatencyMs,initializationMs}={}){
 let kind='unknown',location='edge';
 if(backend==='classical')kind='traditional';
 else if(typeof backend==='string'&&backend.startsWith('onnx:'))kind='model';
 else if(backend==='cloud'){
  location='cloud';
  if(adapterKind==='local-stub'||provider==='local-stub')kind='simulation';
  else if(provider==='shadow')kind='traditional';
  else if(['baidu','birefnet'].includes(provider))kind='model';
 }
 const labels={traditional:location==='edge'?'本地传统算法（非AI模型）':'云端传统算法（非AI模型）',simulation:'模拟实现（仅测试）',unknown:'处理来源待核验',model:location==='edge'?'端侧模型推理':'云端模型（服务自报）'};
 const reasons=[...new Set(reasonCodes.map(safeId).filter(Boolean))];
 if(kind==='traditional'&&location==='cloud'&&!reasons.includes('CLOUD_SHADOW'))reasons.push('CLOUD_SHADOW');
 if(kind==='unknown')reasons.push('PROVIDER_UNVERIFIED');
 return {kind,location,provider:safeId(provider),modelId:kind==='model'?safeId(modelId):null,modelRevision:kind==='model'?safeId(modelRevision):null,serviceVersion:location==='cloud'?safeId(modelRevision):null,artifactSha256:/^[a-f\d]{64}$/i.test(artifactSha256||'')?artifactSha256.toLowerCase():null,
  evidenceLevel:kind==='model'?(location==='edge'?'runtime-executed':'provider-declared'):kind,
  deploymentVerified:false,qualityReview:'not-reviewed',label:labels[kind],reasonCodes:reasons,
  limitation:kind==='traditional'?'传统算法对复杂背景、浅色衣服和发丝可能不可靠，请人工核对或手动修补':'处理成功与数值置信度不代表发丝或视觉质量已验收，请人工核对',
  initializationMs:Number.isFinite(initializationMs)?Math.max(0,initializationMs):null,
  cloudAttempted:!!cloudAttempted,latencyMs:Number.isFinite(latencyMs)?Math.max(0,latencyMs):0,
  cloudLatencyMs:Number.isFinite(cloudLatencyMs)?Math.max(0,cloudLatencyMs):null,
  modelInput:kind==='model'&&location==='edge'&&Number.isInteger(inputSize)&&inputSize>0?{width:inputSize,height:inputSize}:null};
}
module.exports={failureCode,mattingEvidence,safeId};
