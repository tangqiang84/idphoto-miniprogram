'use strict';
const {getSpec,getPixelSize}=require('./specLibrary');
// 旧自绘资产只保留追溯；不能通过放大旧图或填写批准标记替代新素材验收。
const records=['black','navy','gray'].map(id=>({id,asset:'suit_'+id+'.png',native:{width:400,height:400},
 geometry:{width:400,height:400,shoulderWidthPx:360,shoulderY:120,collarTopY:40,collarVy:152},
 approval:'unapproved',licenseEvidence:null,qualityEvidence:null,sourceRevision:'legacy-generated-400',sha256:null,specs:[]}));
const researchRecords=require('./researchSuitTemplates.json');
function getSuitTemplate(id){const item=[...records,...researchRecords].find(t=>t.id===id);return item?JSON.parse(JSON.stringify(item)):null;}
function evaluateSuitTemplate(template,specId){
 const fail=(code,message)=>({ok:false,code,message,template});
 const spec=getSpec(specId);if(!spec)return fail('suit:no_spec','仅支持现有九种标准规格');
 if(!template)return fail('suit:no_template','未找到换装模板');
 if(![template.native?.width,template.native?.height].every(v=>Number.isInteger(v)&&v>0))return fail('suit:template_metadata','模板原生尺寸无效');
 const target=getPixelSize(spec,600),edge=Math.max(template.native?.width||0,template.native?.height||0);
 const research=researchRecords.some(t=>t.id===template.id&&t.sha256===template.sha256)&&template.approval==='research'&&template.usage==='research-only'&&template.usageDecision==='user-20261121-research';
 if((!research&&(template.approval!=='approved'||!template.licenseEvidence))||!template.qualityEvidence||!/^[a-f\d]{64}$/i.test(template.sha256||''))return fail('suit:template_unapproved','当前暂无已验收的换装模板，换装暂不可用');
 if(!template.specs?.includes(specId)||edge<Math.max(1240,2*Math.max(target.width,target.height)))return fail('suit:template_resolution','模板不满足该规格高清输出要求，不能放大旧模板代替');
 const g=template.geometry;
 if(!g||![g.width,g.height,g.shoulderWidthPx,g.shoulderY,g.collarTopY,g.collarVy].every(Number.isFinite)||g.width<=0||g.height<=0||g.shoulderWidthPx<=0||g.shoulderWidthPx>g.width||g.shoulderY<0||g.shoulderY>=g.height||g.collarTopY<0||g.collarTopY>=g.height||g.collarVy<g.collarTopY||g.collarVy>=g.height)return fail('suit:template_metadata','模板几何信息不完整');
 if(Object.prototype.hasOwnProperty.call(g,'shoulderAnchors')&&(!Array.isArray(g.shoulderAnchors)||g.shoulderAnchors.length!==2||!g.shoulderAnchors.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<g.width&&p.y>=0&&p.y<g.height)||g.shoulderAnchors[0].x>=g.shoulderAnchors[1].x))return fail('suit:template_metadata','模板肩峰信息不完整');
 return {ok:true,code:null,message:research?'研究用途模板，视觉效果待核对':'',template};
}
function getSuitTemplateStatus(id,specId){return evaluateSuitTemplate(getSuitTemplate(id),specId);}
module.exports={getSuitTemplate,getSuitTemplateStatus,evaluateSuitTemplate};
