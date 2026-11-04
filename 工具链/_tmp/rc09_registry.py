"""RC-09实际能力与局部证据登记，真实资源缺口不改为完成。"""
from pathlib import Path
import json,hashlib,copy
r=Path(__file__).resolve().parents[2]
def read(p):return json.loads((r/p).read_text())
def write(p,v):(r/p).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
b=read('docs/rc01-baseline.json');old=b['version'];b['version']='RC-01-v1.10'
gaps={
 'B1':'默认传统算法；模型初始化/规格已接线，固定SHA/许可引用/运行时版本缺失拒绝加载。来源区分传统、模拟、未知及模型自报，质量不由置信度证明。用户暂无权重/运行时/服务/真机，真实能力与发丝评审保留待验收。',
 'NFR-QUALITY':'合成复杂/浅衣/细线及授权REAL-111四个传统算法技术样本已运行；浅衣高置信仍低IoU，视觉通过0。缺固定真实图集标注与人工评审，真实模型质量不标完成。',
 'NFR-OFFLINE':'默认禁用模型不下载、传统路径及断网/额度/超时替身有验证；实体机断网和真实服务故障/模型可用性仍未验收。',
 'NFR-1':'记录模型准备、抠图与云调用分别计时，Node/开发者工具不冒充真实设备；中端设备耗时与5/8秒目标仍待验收。',
 'H2.2':'原图/有效窗/工作/处理/目标分离；真实执行的端侧模型另记录规格输入与固定权重SHA，服务自报与未知模型内部输入不冒充已验证。资源未提供，真实模型记录待补。',
}
extra=['idphoto-miniprogram/src/services/modelService.ts','idphoto-miniprogram/src/core/mattingEvidence.js','idphoto-miniprogram/src/core/sha256.js','idphoto-miniprogram/src/components/MattingStatus/index.tsx']
for req in b['requirements']:
 if req['id'] in gaps:
  req['gap']=gaps[req['id']]
  for p in extra:
   if p not in req['evidence']:req['evidence'].append(p)
for name in sorted(set(list(b['code_sha256'])+extra)):
 h=hashlib.sha256((r/name).read_bytes()).hexdigest();before=b['code_sha256'].get(name)
 if h!=before:b['evidence_revisions'].append({'task':'RC-09可执行部分','date':'2026-11-04','file':name,'previous_sha256':before,'sha256':h,'reason':'模型接线、固定资产保护、来源/降级与未评审提示；真实模型/部署/真机资源缺口不变。'});b['code_sha256'][name]=h
write('docs/rc01-baseline.json',b)
p=r/'docs/RC-01需求与现状基线.md';lines=p.read_text().replace('版本：'+old,'版本：'+b['version']).splitlines()
for i,line in enumerate(lines):
 for req in b['requirements']:
  if req['id'] in gaps and line.startswith('| '+req['id']+' |'):
   parts=line.split('|');parts[5]=' '+req['status']+'：'+req['gap']+' '+' '.join('['+Path(n).name+'](../'+n+')' for n in req['evidence'])+' ';lines[i]='|'.join(parts)
p.write_text('\n'.join(lines)+'\n')
c=read('工具链/coverage_cases.json');reqs=read('工具链/prd_requirements.json')
entries=[('IDENTITY',['B1','NFR-QUALITY'],'idphoto-miniprogram/src/core/__tests__/mattingEvidence.test.js','RC-09传统/模拟/未知'),('MODEL',['B1','H2.2','NFR-OFFLINE'],'工具链/tests/model_service.test.js','RC-09实际模型服务'),('STATUS',['B1','NFR-QUALITY'],'工具链/tests/matting_status.test.js','RC-09真实来源提示组件'),('SAMPLES',['B1','NFR-QUALITY','NFR-1'],'工具链/rc09_matting_probe.js','syntheticIoU'),('RESOURCE',['B1','NFR-COMPAT','NFR-OFFLINE'],'工具链/tests/rc09_acceptance.test.js','RC-09资源门禁')]
for suffix,ids,script,selector in entries:
 ident='PART-RC09-'+suffix
 if any(x['id']==ident for x in c['cases']):continue
 base=copy.deepcopy(c['cases'][-1]);base.update(id=ident,requirements=ids,role='partial',kind='artifact' if suffix=='SAMPLES' else 'controller',implementation='implemented',input='默认禁用模型、固定小规格推理替身、正反错误及合成/授权样本',action='验证接线、来源分类、固定摘要与降级；真实资源门禁保持阻断',expected='传统/模拟不显示真模型成功；失败原因可见；未知视觉不标达标；缺资源不通过',negative='固定SHA缺失或错、推理异常/超时、迟到会话、未知provider/云shadow必须正确分类',environment='Node替身/传统算法样本与禁云微信SDK分开；无实际模型权重/外部调用/实体机',limitations='仅可执行部分；真实模型、部署、复杂背景/浅衣/发丝人工质量和真机仍待验收',runner={'script':script,'selector':selector,'command':('node '+script+' --out <新目录>') if suffix=='SAMPLES' else 'node --test '+script},followup=['RC-09','RC-10','RC-11','RC-12']);c['cases'].append(base)
 for req in reqs['requirements']:
  if req['id'] in ids and ident not in req['cases']:req['cases'].append(ident)
for req in reqs['requirements']:req['source']['version']=b['version']
write('工具链/coverage_cases.json',c);write('工具链/prd_requirements.json',reqs)
p=r/'工具链/tests/coverage_matrix.test.js';p.write_text(p.read_text().replace('matrix.implementedCases, 25','matrix.implementedCases, 30'))
