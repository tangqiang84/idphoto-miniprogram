"""RC-07更新现状、授权决策和局部验收映射；不删除需求。"""
from pathlib import Path
import hashlib,json,shutil
root=Path(__file__).resolve().parents[2]
def read(p):return json.loads((root/p).read_text())
def write(p,v):(root/p).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
b=read('docs/rc01-baseline.json')
if b['version']!='RC-01-v1.7':raise SystemExit('非预期基线，拒绝重复迁移')
b['version']='RC-01-v1.8'
b['decisions'].append({'id':'D-04','status':'用户确认','source':'2026-11-04本会话用户回复“采用，开始”并再次要求继续RC-07','text':'T2透明PNG可作为素材导出，醒目提示不符合证件底色要求；保留其他检查，不放宽T1/T3。'})
gaps={
 'B2':'T1/T2/T3/T5现用统一会话和独立裁剪确认；原图坐标窗持续传入处理。控制回归及微信样例通过，全规格像素/构图质量仍归RC-08/09/12。',
 'C1':'T2已接纯色/渐变控件及真实合成，负角度投影已修正；预览与成品共用同一参数。颜色图集及全部规格质量仍待RC-08/12。',
 'C2':'T2真实颜色控件支持HEX/RGB并拒绝越界；Node控制与真实微信同色JPEG文件哈希一致，不据单样本证明所有规格。',
 'C3':'T2透明PNG已接新流程；按D-04底色不符提示风险，但300档大小等其余硬指标仍阻断，600档按既有提示例外执行。',
 'D3':'T3换装无跳过，预览及最终新结果分别自检，未实际换装不能导出；Node及本地微信流程验证，模板质量仍归RC-10。',
 'E1':'T1/T2/T3裁剪后均进入独立美颜确认/跳过，之后才抠图；T5无美颜节点。实际轻度效果质量另验。',
 'F2':'T5保留九标准规格、自定义1–5000整数像素和KB压缩上限，裁剪/档位/最终输出独立；全部规格及元数据一致性归RC-08。',
 'J3':'T1至T5照片处理策略按工具配置，T2/T3/T5复用共享会话/页面/平台处理；T4只读和T6独立拼版由隔离控制回归，真实质量/双平台仍待后续。',
 'FLOW-2':'T2已强制规格、独立裁剪/美颜/换底预览/预审/档位/最终输出，无换装；控制与微信样例验证，不以此认领全规格质量。',
 'FLOW-3':'T3九规格、换装必选、两次当前结果自检；控制和微信本地链路验证，实际模板质量待RC-10。',
 'FLOW-5':'T5选图仅进入裁剪、确认后档位，最终纯图像缩放/压缩不调用人脸检测/抠图/美颜/姿态；控制和微信样例验证。',
}
new=['idphoto-miniprogram/src/components/PhotoTool/index.tsx','idphoto-miniprogram/src/components/BackgroundControl/index.tsx','idphoto-miniprogram/src/services/t1Processing.ts','idphoto-miniprogram/src/hooks/useT1Workflow.ts']
for r in b['requirements']:
 if r['id'] in gaps:
  r['gap']=gaps[r['id']]
  for n in new:
   if n not in r['evidence']:r['evidence'].append(n)
for n in sorted(set(p for r in b['requirements'] for p in r['evidence'] if p.startswith('idphoto-miniprogram/'))):
 h=hashlib.sha256((root/n).read_bytes()).hexdigest();old=b['code_sha256'].get(n)
 if h!=old:b['evidence_revisions'].append({'task':'RC-07','date':'2026-11-04','file':n,'previous_sha256':old,'sha256':h,'reason':'T2/T3/T5共享流程/页面/处理迁移及颜色/纯变换接线，需求不缩减，质量/真机独立待验。'});b['code_sha256'][n]=h
write('docs/rc01-baseline.json',b)
p=root/'docs/RC-01需求与现状基线.md';lines=p.read_text().replace('版本：RC-01-v1.7','版本：RC-01-v1.8').splitlines()
for i,line in enumerate(lines):
 for r in b['requirements']:
  if r['id'] in gaps and line.startswith('| '+r['id']+' |'):
   cells=line.split('|');cells[5]=' '+r['status']+'：'+r['gap']+' '+' '.join('['+Path(n).name+'](../'+n+')' for n in r['evidence'])+' ';lines[i]='|'.join(cells)
p.write_text('\n'.join(lines)+'\n\nRC-07更新（2026-11-04）：v1.8显式登记D-04透明PNG素材导出决策及迁移现状，76条需求描述和历史任务不变。\n')
req=read('工具链/prd_requirements.json');cases=read('工具链/coverage_cases.json')
for r in req['requirements']:r['source']['version']=b['version']
for c in cases['cases']:
 if c['id'].startswith('ACCEPT-') and c['id'][7:] in gaps:c['limitations']=gaps[c['id'][7:]]
for id,ids,kind,script,selector,details in [
 ('PART-RC07-POLICY',['B2','D3','F2','J3','FLOW-2','FLOW-3','FLOW-5'],'unit','idphoto-miniprogram/src/core/__tests__/toolWorkflow.test.js','RC-07 T2预览后直接预审','5项策略/参数/反向渐变测试，非实际文件'),
 ('PART-RC07-PAGES',['B2','C1','C2','C3','D3','F2','J3','FLOW-2','FLOW-3','FLOW-4','FLOW-5','FLOW-6','AC12'],'controller','工具链/tests/tool_migration.test.js','RC-07实际T2页面','5项真实页面/hook/处理及T4/T6隔离；SDK与质量算法替身，非真实模型'),
 ('PART-RC07-COLOR',['C1','C2','C3'],'controller','工具链/tests/background_control.test.js','RC-07真实颜色控件','真实控件输入/拒绝/切换；非SDK落盘'),
 ('PART-RC07-SDK',['C2','C3','FLOW-2','FLOW-3','FLOW-5','AC12'],'artifact','工具链/smoke_rc07.js','HEX_RGB_FILE_MISMATCH','须显式禁云副本与自动化端口；真实本地微信UI/文件，非云模型或实体机'),
]:
 cases['cases'].append({'id':id,'requirements':ids,'role':'partial','kind':kind,'implementation':'implemented','input':'固定合法照片、已确认规格、正反动作与参数','action':'执行共享流程/真实页面并验证禁止动作和最终输出角色','expected':'确认前零下游；差异按工具配置；颜色/自检/输出与当前会话绑定','negative':'提前处理、绕过换装、自检或非法RGB进入处理必须失败','environment':'按用例分别Node控制/真实禁云SDK，禁止混称真实模型','limitations':details,'runner':{'script':script,'selector':selector,'command':('node --test '+script) if script.endswith('test.js') else 'node 工具链/smoke_rc07.js --app <禁云副本> --tool T2 --out <新目录>'},'followup':['RC-08','RC-10','RC-12'],'evidence_policy':'局部断言不认领整条跨工具/质量/真机需求通过'})
 for r in req['requirements']:
  if r['id'] in ids:r['cases'].append(id)
write('工具链/prd_requirements.json',req);write('工具链/coverage_cases.json',cases)
p=root/'工具链/tests/coverage_matrix.test.js';p.write_text(p.read_text().replace('matrix.implementedCases, 17','matrix.implementedCases, 21'))
shutil.copy2(root/'docs/覆盖矩阵.md',root/'docs/验证记录/RC-07-implementation/覆盖矩阵-迁移前.md')
