"""RC-08现状/局部覆盖登记；保留全量主验收门禁。"""
from pathlib import Path
import hashlib,json,copy
r=Path(__file__).resolve().parents[2]
def read(p):return json.loads((r/p).read_text())
def write(p,v):(r/p).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
b=read('docs/rc01-baseline.json');oldversion=b['version'];newversion='RC-01-v1.9'
gaps={
 'H1':'最终导出核验实际尺寸、格式与原始字节；300档机构KB边界严格，不用取整掩盖超限。真实文件矩阵及像素/元数据证据见RC-08报告；模型/视觉/实体机仍另验。',
 'H2':'300/600为输出像素档，不承诺文件dpi元数据；原图有效裁剪与工作/处理输入分开溯源，低像素明确提示，不把放大工作图当真实细节。',
 'H2.1':'机构文件KB原始字节在300档严格、600档只提示；T5用户显式上限两档仍严格。负例与边界回归已补。',
 'H2.2':'原图有效裁剪/工作画布/分割入口/处理裁剪/目标分别记录；处理分辨率不足提示。未观测模型内部缩放，不宣称神经模型内部输入达标。',
 'F2':'T5九规格双档、自定义固定像素与KB输出继续统一会话；固定72条四工具页面/适配路径通过，元数据无写入承诺。',
 'K3':'16相纸×9规格纯几何检查和真实T6文件样例；毫米坐标后一次舍入，单张相纸不可拼版、放不下拒绝。纸张旋转与照片旋转区分；非实体机冲印结果。',
 'K4':'最终JPG尺寸/格式/字节实测；白底及参考线保留，开参考线会写入拼版图。相纸mm×原生像素档，不承诺DPI元数据。',
 'K5':'全部16相纸×9规格独立固定整纸像素（容差1）及边界、单张/拒绝几何；打印机实体机物理误差仍归RC-12。',
}
extra=['idphoto-miniprogram/src/core/outputEvidence.js','idphoto-miniprogram/src/services/exportInspection.ts','idphoto-miniprogram/src/core/printGeometry.js']
for req in b['requirements']:
 if req['id'] in gaps:
  req['gap']=gaps[req['id']]
  for n in extra:
   if n not in req['evidence']:req['evidence'].append(n)
for n in sorted(set(list(b['code_sha256'])+extra)):
 h=hashlib.sha256((r/n).read_bytes()).hexdigest();old=b['code_sha256'].get(n)
 if h!=old:b['evidence_revisions'].append({'task':'RC-08','date':'2026-11-04','file':n,'previous_sha256':old,'sha256':h,'reason':'有效原图像素/最终文件/相纸几何一致性；不缩减需求或宣称模型质量达标。'});b['code_sha256'][n]=h
b['version']=newversion;write('docs/rc01-baseline.json',b)
p=r/'docs/RC-01需求与现状基线.md';lines=p.read_text().replace('版本：'+oldversion,'版本：'+newversion).splitlines()
for i,line in enumerate(lines):
 for ident,gap in gaps.items():
  if line.startswith('| '+ident+' |'):
   parts=line.split('|');parts[5]=' '+next(x for x in b['requirements'] if x['id']==ident)['status']+'：'+gap+' '+' '.join('['+Path(n).name+'](../'+n+')' for n in next(x for x in b['requirements'] if x['id']==ident)['evidence'])+' ';lines[i]='|'.join(parts)
p.write_text('\n'.join(lines)+'\n')
c=read('工具链/coverage_cases.json');reqs=read('工具链/prd_requirements.json')
new=[('PIXELS',['H2','H2.2','F2'],'工具链/tests/dpi_evidence.test.js','RC-08实际档位组件'),('FILES',['H1','H2.1','AC4'],'工具链/tests/output_matrix.test.js','RC-08最终文件原始字节边界'),('PRINT',['K3','K4','K5'],'工具链/tests/print_output.test.js','RC-08实际T6'),('SDK',['H1','H2','K4'],'工具链/smoke_output_matrix.js','T5九规格双档')]
for suffix,ids,script,selector in new:
 ident='PART-RC08-'+suffix
 if any(x['id']==ident for x in c['cases']):continue
 base=copy.deepcopy(c['cases'][-1]);base.update(id=ident,requirements=ids,role='partial',kind='artifact' if suffix=='SDK' else 'controller',implementation='implemented',input='固定授权样本/独立规格与相纸参考期望/字节边界与非法实际格式',action='执行真实页面和平台适配或禁云SDK文件矩阵，独立核验像素和文件',expected='有效裁剪像素独立于工作图；实际格式尺寸字节与目标一致；相纸边界及单张约束',negative='过限一字节/格式不符/小裁剪/无法容纳不得误报满足或提供成品',environment='Node平台替身与真实禁云微信SDK分开记录',limitations='局部流程/文件证据；非模型质量、实体机冲印或全需求通过',runner={'script':script,'selector':selector,'command':('node '+script+' --app <禁云副本> --port <端口> --out <新目录>') if suffix=='SDK' else 'node --test '+script},followup=['RC-09','RC-10','RC-11','RC-12']);c['cases'].append(base)
 for req in reqs['requirements']:
  if req['id'] in ids and ident not in req['cases']:req['cases'].append(ident)
for req in reqs['requirements']:req['source']['version']=newversion
write('工具链/coverage_cases.json',c);write('工具链/prd_requirements.json',reqs)
p=r/'工具链/tests/coverage_matrix.test.js';p.write_text(p.read_text().replace('matrix.implementedCases, 21','matrix.implementedCases, 25'))
