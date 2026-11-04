"""RC-08收尾一致性；源码/构建/SDK/独立文件/文档检查，不把门禁缺口变成通过。"""
from pathlib import Path
import hashlib,json,subprocess,datetime,re,urllib.parse,argparse
r=Path(__file__).resolve().parents[2];p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();out=r/'docs/验证记录/RC-08-implementation'
prod=r/'docs/验证记录/verify-runs/run-20261104-164559-e6a360eb';local=r/'docs/验证记录/t1-local-builds/run-216972338aa1'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();read=lambda p:json.loads(p.read_text());checks=[]
def check(name,count,errors):checks.append({'name':name,'count':count,'status':'FAIL' if errors else 'PASS','errors':errors})
inputs=read(prod/'inputs.json');app={k:v for k,v in inputs.items() if k.startswith('idphoto-miniprogram/')}
check('当前应用与生产构建输入',len(app),[n for n,h in app.items() if not (r/n).exists() or sha(r/n)!=h])
src=r/'idphoto-miniprogram/src';copy=local/'workspace/idphoto-miniprogram/src';files=[p for p in src.rglob('*') if p.is_file() and str(p.relative_to(src)) not in ['services/cloudFnAdapter.ts','services/poseService.ts']]
check('最终禁云副本应用源码（明确两项网络适配除外）',len(files),[str(p.relative_to(src)) for p in files if not (copy/p.relative_to(src)).exists() or sha(p)!=sha(copy/p.relative_to(src))])
for name,base in [('生产',prod),('禁云',local)]:
 manifest=read(base/'build-files.json');dist=base/'workspace/idphoto-miniprogram/dist';check(name+'构建产物',len(manifest),[n for n,h in manifest.items() if not (dist/n).exists() or sha(dist/n)!=h])
old=read(r/'docs/验证记录/verify-runs/run-20261104-161039-97ac5613/inputs.json');deps=[n for n in inputs if n.endswith(('package.json','package-lock.json'))];check('依赖及锁文件不变',len(deps),[n for n in deps if old[n]!=sha(r/n)])
sdk=out/'sdk-tools';summary=read(sdk/'summary.json');check('四工具SDK串行成功成品',4,[] if len(summary)==4 and all(x['exit_code']==0 for x in summary) else ['退出码不完整'])
for tool in ['T1','T2','T3','T5']:
 d=read(sdk/tool/'report.json');check(tool+'本地真实文件链',len(d['checks']),[] if d['status']=='PASS' and d.get('result') and not d.get('outcome') and not d['runtimeErrors'] else ['不是实际成功成品'])
d=read(out/'sdk-matrix-final/report.json');check('SDK矩阵23文件及1预期拒绝',len(d['cases']),[] if d['status']=='PASS' and len(d['cases'])==24 and not d['runtimeErrors'] and d.get('pixelWarning',{}).get('status')=='PASS' else ['矩阵/真实像素提示不完整'])
f=read(out/'files-complete.json');check('Pillow独立格式/尺寸/元数据/白边',len(f['records']),f['errors'] if f['status']=='PASS' else f['errors']+['独立文件检查不通过'])
# 所有受影响文档的新段落链接；历史段落只保留不改写。
docs=['docs/RC-08开工检查.md','docs/RC-08像素与导出一致性说明.md','docs/整改开发任务.md','docs/验证记录/RC-08-implementation/验收报告.md','项目资产与工具手册.md','技术架构说明.md','小程序开发指南.md','产品功能清单.md','页面原型设计.md','测试用例与验收清单.md','docs/验证体系说明.md','开发任务台账.md','问题台账.md','每日开发日志/2026-11-04.md']
errors=[];count=0
for name in docs:
 path=r/name;s=path.read_text();marker='## RC-08 像素与导出一致性（2026-11-04）'
 if marker in s:s=s.split(marker,1)[1]
 for target in re.findall(r'\]\(([^)]+)\)',s):
  if re.match(r'^[a-z]+://',target) or target.startswith('#'):continue
  count+=1;target=urllib.parse.unquote(target.split('#')[0].strip('<>'))
  if not (path.parent/target).exists():errors.append(name+':'+target)
check('本轮文档链接',count,errors)
record={'status':'FAIL' if any(c['status']=='FAIL' for c in checks) else 'PASS','timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=str(r)).decode().strip(),'tracked_diff_sha256':hashlib.sha256(subprocess.check_output(['git','diff','--binary'],cwd=str(r))).hexdigest(),'current_input_sha256':{n:sha(r/n) for n in app},'worktree_status':subprocess.check_output(['git','status','--porcelain'],cwd=str(r)).decode().splitlines(),'artifacts':{str(p.relative_to(out)):sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name!=a.out},'documents':{n:sha(r/n) for n in docs},'production_build_id':sha(prod/'build-files.json'),'local_build_id':sha(local/'build-files.json'),'scope':'RC-08像素/实际文件/控制/固定样本，不等于全规格视觉质量或实体机/云模型/发布验收'}
if Path(a.out).name!=a.out:raise SystemExit('非法报告名')
with (out/a.out).open('x') as stream:json.dump(record,stream,ensure_ascii=False,indent=2)
print(json.dumps({'status':record['status'],'checks':checks},ensure_ascii=False));raise SystemExit(record['status']!='PASS')
