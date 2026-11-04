'use strict';
const validSize=s=>s&&Number.isFinite(s.width)&&s.width>0&&Number.isFinite(s.height)&&s.height>0;
function assessPixels(effective,target,processing){
 const enough=s=>validSize(s)&&validSize(target)?s.width+0.5>=target.width&&s.height+0.5>=target.height:null;
 return {sourceEnough:enough(effective),processingEnough:enough(processing)};
}
function validateArtifact(file,target,format){
 const fail=(code,message)=>({ok:false,code,message});
 if(!file||!Number.isSafeInteger(file.bytes)||file.bytes<=0||!validSize(file))return fail('EXPORT_INVALID','无法核验导出文件，请重试');
 if(file.width!==target.width||file.height!==target.height)return fail('EXPORT_DIMENSION','实际文件尺寸与目标不符，请重新生成');
 const actual=file.type==='jpeg'?'jpg':file.type;
 if(actual!==format)return fail('EXPORT_FORMAT','实际文件格式与目标不符，请重新生成');
 return {ok:true,width:file.width,height:file.height,fileBytes:file.bytes,fileKb:file.bytes/1024,fileType:actual,dpiMetadata:'not-written'};
}
module.exports={assessPixels,validateArtifact};
