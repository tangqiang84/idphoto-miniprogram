"""RC-09可执行部分与外部缺口分开核验；整体状态不得因技术检查通过而变PASS。"""
from pathlib import Path
import hashlib,json,subprocess,datetime,re,urllib.parse,argparse
r=Path(__file__).resolve().parents[2];p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();out=r/'docs/验证记录/RC-09-implementation'
read=lambda p:json.loads(p.read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();binding=read(out/'build-binding.json');prod=r/binding['production'];local=r/binding['local'];checks=[]
def check(name,count,errors):checks.append({'name':name,'count':count,'status':'FAIL' if errors else 'PASS','errors':errors})
inputs=read(prod/'inputs.json');app={n:h for n,h in inputs.items() if n.startswith('idphoto-miniprogram/')};check('当前应用与最终生产构建输入',len(app),[n for n,h in app.items() if not (r/n).exists() or sha(r/n)!=h])
src=r/'idphoto-miniprogram/src';copy=local/'workspace/idphoto-miniprogram/src';files=[p for p in src.rglob('*') if p.is_file() and str(p.relative_to(src)) not in ['services/cloudFnAdapter.ts','services/poseService.ts']];check('最终禁云副本源码（两项明确网络替换除外）',len(files),[str(p.relative_to(src)) for p in files if not (copy/p.relative_to(src)).exists() or sha(p)!=sha(copy/p.relative_to(src))])
for name,base in [('生产',prod),('禁云',local)]:
 d=read(base/'build-files.json');dist=base/'workspace/idphoto-miniprogram/dist';check(name+'构建产物',len(d),[n for n,h in d.items() if not (dist/n).exists() or sha(dist/n)!=h])
old=read(r/'docs/验证记录/verify-runs/run-20261104-164559-e6a360eb/inputs.json');deps=[n for n in inputs if n.endswith(('package.json','package-lock.json'))];check('依赖和锁文件不变',len(deps),[n for n in deps if old[n]!=sha(r/n)])
sdk=out/'sdk-tools-final';summary=read(sdk/'summary.json');check('四工具串行微信回归',4,[] if len(summary)==4 and all(x['exit_code']==0 for x in summary) else ['回归不完整'])
expected_app=str(local/'workspace/idphoto-miniprogram')
for name,folder in [('model-smoke',out/'sdk-model-final')]+[(t,sdk/t) for t in ['T1','T2','T3','T5']]:
 d=read(folder/'report.json');errors=[]
 if d['status']!='PASS' or not d.get('result') or d.get('outcome') or d['runtimeErrors'] or d['app']!=expected_app:errors.append('非当前构建真实成功链路')
 if name!='T5' and (d.get('mattingSource',{}).get('provider')!='classical' or d.get('mattingSource',{}).get('qualityReviewed') is not False):errors.append('缺少传统/未评审真实UI证据')
 check(name+'实际来源及成品',len(d['checks']),errors)
f=read(out/'files-final.json');check('独立5个真实文件',len(f['records']),[] if f['status']=='PASS' and len(f['records'])==5 else ['文件不符'])
samples=read(out/'samples-frozen/report.json');check('4个固定本地传统技术样本（非视觉验收）',len(samples['records']),[] if samples['status']=='PASS' and samples['counts']=={'traditional':4,'realModel':0,'cloudReal':0,'simulation':0,'visualPass':0,'visualSkipped':4} else ['样本/来源统计不符'])
resource=read(out/'resource-gate-release.json');check('资源缺口保持独立阻断',len(resource['items']),[] if resource['status']=='BLOCKED' and resource['counts']=={'PASS':0,'FAIL':0,'BLOCKED':8,'SKIPPED':1} else ['资源状态被错误改变'])
docs=['docs/整改开发任务.md','docs/RC-09开工记录.md','docs/RC-09能力与降级说明.md','docs/验证记录/RC-09-implementation/验收报告.md','项目资产与工具手册.md','技术架构说明.md','小程序开发指南.md','产品功能清单.md','测试用例与验收清单.md','页面原型设计.md','docs/验证体系说明.md','开发任务台账.md','问题台账.md','每日开发日志/2026-11-04.md'];errors=[];count=0
for name in docs:
 path=r/name;s=path.read_text();marker='## RC-09 可执行部分与资源待验收（2026-11-04）'
 if marker in s:s=s.split(marker,1)[1]
 for target in re.findall(r'\]\(([^)]+)\)',s):
  if re.match(r'^[a-z]+://',target) or target.startswith('#'):continue
  count+=1;target=urllib.parse.unquote(target.split('#')[0].strip('<>'))
  if not (path.parent/target).exists():errors.append(name+':'+target)
check('本轮文档链接',count,errors)
technical='FAIL' if any(c['status']=='FAIL' for c in checks) else 'PASS'
record = {
 'status': 'BLOCKED' if technical == 'PASS' else 'FAIL',
 'technicalStatus': technical,
 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'checks': checks,
 'resourceCounts': resource['counts'],
 'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=str(r)).decode().strip(),
 'trackedDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--binary'], cwd=str(r))).hexdigest(),
 'headDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=str(r))).hexdigest(),
 'stagedDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', '--cached', '--binary'], cwd=str(r))).hexdigest(),
 'worktreeStatus': subprocess.check_output(['git', 'status', '--porcelain'], cwd=str(r)).decode().splitlines(),
 'binding': binding,
 'currentAppInputs': {n: sha(r/n) for n in app},
 'documents': {n: sha(r/n) for n in docs},
 'artifacts': {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name != a.out},
 'scope': '技术收尾核验；RC-09因真实模型/部署/质量/实体机缺口不标完成',
}

if Path(a.out).name!=a.out:raise SystemExit('非法报告名')
with (out/a.out).open('x') as f:json.dump(record,f,ensure_ascii=False,indent=2)
print(json.dumps({'status':record['status'],'technicalStatus':technical,'checks':checks},ensure_ascii=False));raise SystemExit(0 if technical=='PASS' else 1)
